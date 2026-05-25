# @elumixor/nitro-bot

Auto-generate an LLM chat-bot endpoint from your existing Nitro routes.

## How it works

1. Install the package and enable the Nitro module.
2. Mark any route that the LLM may call as a tool, by adding `export const definition = tool({...})`.
3. Optionally drop a `chat.config.ts` next to your `nitro.config.ts` with the system prompt and other settings.

That's it. On dev/build the module scans your `routes/` directory, finds the tool markers, and mounts a chat endpoint (default `/chat`) that lets an LLM call those routes via Nitro's in-process `$fetch`.

## Setup

```bash
bun add @elumixor/nitro-bot
```

```ts
// nitro.config.ts
import { nitroBotModule } from "@elumixor/nitro-bot";

export default defineNitroConfig({
  modules: [nitroBotModule()],
});
```

```ts
// chat.config.ts (optional)
import { defineChatConfig } from "@elumixor/nitro-bot";

export default defineChatConfig({
  endpoint: "/chat",
  method: "POST",        // or "GET"
  promptField: "message", // request field carrying the user prompt
  systemPrompt: "You are a concise assistant. Use the provided tools when they cover what the user asks.",
});
```

## Mark routes as tools

```ts
// src/routes/weather.get.ts
import { tool } from "@elumixor/nitro-bot";
import { defineEventHandler, getQuery } from "h3";
import { z } from "zod";

export const definition = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: { city: z.string() },
});

export default defineEventHandler((event) => {
  const { city } = getQuery(event) as { city?: string };
  return { city, tempCelsius: 21 };
});
```

### Reusing a schema from `@elumixor/nitro-client`

If your default export is a call whose first argument is an object literal with `body` and/or `query` keys (the shape used by [`@elumixor/nitro-client`](https://github.com/elumixor/nitro-client)'s `handler()`), the discovery scanner pulls that schema out at build time and uses it as the tool's input — you don't need to repeat it on `tool()`:

```ts
// src/routes/greet.post.ts
import { tool } from "@elumixor/nitro-bot";
import { z } from "zod";
import { handler } from "../utils/handler"; // nitro-client's createHandler()

export const definition = tool({
  name: "greet",
  description: "Greet someone by name.",
});

export default handler(
  {
    body: {
      name: z.string().describe("The person to greet."),
      excited: z.boolean().optional().describe("Use an exclamation mark."),
    },
  },
  ({ body }) => ({ greeting: `Hello, ${body.name}${body.excited ? "!" : "."}` }),
);
```

How it works: nitro-bot parses each tool-marked route file with `ts-morph`. If the default export is `handler(SCHEMA, fn)` and `SCHEMA.body` / `SCHEMA.query` are object literals, the literal source is copied into the generated chat handler and used as the tool input — body and query are merged with body winning on collision. The `z` identifier (and any other identifier in the literal) must be importable from `zod`; non-zod helpers won't resolve. For those cases, pass `input` explicitly on `tool()` instead — explicit `input` always wins over auto-detection.

You get a `/chat` endpoint automatically:

```bash
curl -X POST localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what is the weather in berlin"}'
```

## Configuration

`chat.config.ts` accepts:

- `endpoint` (default `"/chat"`)
- `method` — `"POST"` (default) or `"GET"`
- `promptField` — name of the body/query field that carries the prompt (default `"message"`)
- `systemPrompt`
- `model` — any AI SDK `LanguageModel` (default `"anthropic/claude-sonnet-4.6"` via the Vercel AI Gateway)
- `maxSteps` (default `8`)

So the default request is:

```bash
curl -X POST localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"..."}'
```

If you set `method: "GET"` with `promptField: "q"`:

```bash
curl -G 'http://localhost:3000/chat' --data-urlencode 'q=...'
```

## Providers & env vars

`model` is the AI SDK's `LanguageModel`. It accepts two shapes:

### 1. Gateway string (default)

```ts
defineChatConfig({ model: "anthropic/claude-sonnet-4.6" });
```

Routed through the Vercel AI Gateway, which abstracts over Anthropic, OpenAI, Google, etc. and gives you per-model fallback + observability. Requires `AI_GATEWAY_API_KEY` in your environment (or the auto-injected `VERCEL_OIDC_TOKEN` when deployed on Vercel).

```env
# .env (Nitro auto-loads this in dev)
AI_GATEWAY_API_KEY=sk-...
```

### 2. Provider instance

Install the provider package you want and pass an instance. No gateway involved — calls go straight to the provider.

```bash
bun add @ai-sdk/anthropic     # or @ai-sdk/openai, @ai-sdk/google, ...
```

```ts
// chat.config.ts
import { defineChatConfig } from "@elumixor/nitro-bot";
import { anthropic } from "@ai-sdk/anthropic";

export default defineChatConfig({
  model: anthropic("claude-sonnet-4-5-20250929"),
});
```

Each provider auto-reads its own env var:

| Provider package | Env var |
| --- | --- |
| `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` |
| `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `@ai-sdk/groq` | `GROQ_API_KEY` |
| Gateway string | `AI_GATEWAY_API_KEY` |

### Custom env var or runtime key

If your key lives under a different env var (or you load it from a secret manager), build the provider yourself with the `create*` helper:

```ts
import { defineChatConfig } from "@elumixor/nitro-bot";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.MY_ANTHROPIC_KEY,
  // baseURL: "https://proxy.example.com/v1", // optional override
});

export default defineChatConfig({
  model: anthropic("claude-sonnet-4-5-20250929"),
});
```

Same pattern works for `createOpenAI`, `createGoogleGenerativeAI`, `createGateway`, etc.

### Where to set the env var

- **Local dev**: drop a `.env` next to your `nitro.config.ts`. Nitro auto-loads it.
- **Vercel**: set it in *Project Settings → Environment Variables*, or run `vercel env add`.
- **Other hosts**: set it like any other env var. The AI SDK reads `process.env` at request time, so no rebuild is needed when rotating keys.

## `maxSteps` and tool-call limits

`maxSteps` (default `8`) is the **maximum number of model generation steps** in one chat turn — *not* a tool-call counter. Internally we pass it as `stopWhen: stepCountIs(maxSteps)` to AI SDK `generateText`.

A "step" is one call to the model. The agent loop looks like this:

```
step 1: model decides → "call get_weather({city: 'Berlin'})"
        ↳ we run the tool, hand the result back
step 2: model decides → "call add({a: 17, b: 4})"
        ↳ we run the tool
step 3: model decides → final answer
```

So `maxSteps: 8` allows roughly **up to 7 sequential tool calls before the final answer is forced**. Parallel tool calls within one step count as one step, so the practical limit can be higher.

The response includes the actual step count:

```json
{ "text": "...", "steps": 2 }
```

If the model hits `maxSteps`, you'll still get whatever text it produced on the last step (it can't make another tool call). Pick a value that's comfortably above your typical depth — tight limits silently truncate complex queries.

## What's next

Streaming, subagents, file attachments, and chat-platform adapters (Telegram / Slack / Discord) are on the roadmap.
