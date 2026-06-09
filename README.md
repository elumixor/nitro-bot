# @elumixor/nitro-bot

Auto-generate an LLM chat-bot endpoint from your existing Nitro routes.

## How it works

1. Install the package and enable the Nitro module.
2. Mark any route that the LLM may call as a tool, by adding `export const definition = tool({...})`.
3. Pass config (system prompt, adapters, etc.) directly to `nitroBotModule({...})` in `nitro.config.ts`.

That's it. On dev/build the module scans your `routes/` directory, finds the tool markers, and mounts a chat endpoint (default `/chat`) that lets an LLM call those routes via Nitro's in-process `$fetch`.

## Setup

```bash
bun add @elumixor/nitro-bot
```

```ts
// nitro.config.ts
import { nitroBotModule } from "@elumixor/nitro-bot";

export default defineNitroConfig({
  modules: [
    nitroBotModule({
      endpoint: "/chat",
      source: "json",   // "query" | "json" | "form"
      field: "message", // name of the field carrying the user prompt
      systemPrompt: "You are a concise assistant. Use the provided tools when they cover what the user asks.",
    }),
  ],
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

## Group tools into subagents

When a bot grows past a dozen or so tools, one agent juggling all of them gets slower and picks the wrong tool more often. Group related tools under a **subagent**: the top-level agent (the coordinator) then sees a single `delegate_to_<name>` tool per group instead of every tool at once, and hands the work off.

Declare a subagent under `src/bots/<name>/subagents/*.ts` — the file name is the group key:

```ts
// src/bots/telegram/subagents/weather.ts
import { defineSubagent } from "@elumixor/nitro-bot";

export default defineSubagent({
  // name defaults to the file name ("weather"); the description is what the coordinator routes on
  description: "Weather lookups — current temperature for a city.",
  systemPrompt: "You answer weather questions. Look up the city and report the temperature plainly.",
  // optional: model, maxSteps overrides for this subagent's own loop
});
```

Tag any route tool or bot-local tool into it with `subagent: "<name>"`:

```ts
export const definition = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: { city: z.string() },
  subagent: "weather", // reached only via delegate_to_weather
});
```

How it routes:

- **Coordinator** runs with the shared (untagged) tools plus one `delegate_to_<name>` per subagent. It calls a delegate with a self-contained `task` string.
- **Subagent** runs its own agent loop over its tagged tools _plus_ the shared tools, then returns a summary to the coordinator.
- **Untagged tools are shared** — available to the coordinator and to every subagent. Keep cross-cutting lookups (resolve-a-person, send-a-file, remember) untagged so every layer can use them.
- The live `🔧` trail nests subagent calls under the delegate that triggered them.

Declare no subagents and nothing changes — the coordinator keeps the full flat tool set (fully backward compatible).

## Configuration

`nitroBotModule({...})` accepts:

- `endpoint` (default `"/chat"`)
- `source` — where the prompt comes from: `"json"` (default), `"query"`, or `"form"`
- `field` — the name of that field (default `"message"`)
- `systemPrompt`
- `model` — any AI SDK `LanguageModel` (default `"anthropic/claude-sonnet-4.6"` via the Vercel AI Gateway)
- `maxSteps` (default `8`)

`source` also determines the HTTP method: `"query"` → `GET`, `"json"` / `"form"` → `POST`.

| `source` | Method | How to call |
| --- | --- | --- |
| `"json"` (default) | `POST` | `curl -X POST localhost:3000/chat -H 'content-type: application/json' -d '{"message":"..."}'` |
| `"query"` | `GET` | `curl -G 'http://localhost:3000/chat' --data-urlencode 'message=...'` |
| `"form"` | `POST` | `curl -X POST localhost:3000/chat -F 'message=...'` |

In each case, replace `message` with whatever you set `field` to.

## Providers & env vars

`model` is the AI SDK's `LanguageModel`. It accepts two shapes:

### 1. Gateway string (default)

```ts
nitroBotModule({ model: "anthropic/claude-sonnet-4.6" });
```

Routed through the Vercel AI Gateway, which abstracts over Anthropic, OpenAI, Google, etc. and gives you per-model fallback + observability. Requires `AI_GATEWAY_API_KEY` in your environment (or the auto-injected `VERCEL_OIDC_TOKEN` when deployed on Vercel).

```env
# .env (Nitro auto-loads this in dev)
AI_GATEWAY_API_KEY=sk-...
```

### 2. Direct provider

To skip the gateway, install a provider package and pass its env var:

| Provider package | Env var |
| --- | --- |
| `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` |
| `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `@ai-sdk/mistral` | `MISTRAL_API_KEY` |
| `@ai-sdk/groq` | `GROQ_API_KEY` |
| Gateway string | `AI_GATEWAY_API_KEY` |

Then pass `model` as a string in the AI SDK's `provider/model` form — `nitroBotModule({...})` config is serialized into a generated runtime file at build time, so values must be plain data. For provider instances built via `createAnthropic({ apiKey: ... })` and similar, construct them inside a route or your own runtime module instead of the module config.

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

## Chat platforms (Telegram, Slack, Discord, ...)

Bring any [Chat SDK](https://www.npmjs.com/package/chat) adapter into your module config. Everything in `adapters` is started alongside the HTTP `/chat` endpoint and routed through the same agent.

```bash
bun add @chat-adapter/telegram   # or @chat-adapter/slack, @chat-adapter/discord, ...
```

```ts
// nitro.config.ts
import { nitroBotModule, telegramAdapter } from "@elumixor/nitro-bot";

export default defineNitroConfig({
  modules: [
    nitroBotModule({
      systemPrompt: "...",
      adapters: [
        telegramAdapter(),                                    // polling (reads TELEGRAM_BOT_TOKEN)
        // telegramAdapter({ webhookUrl: "https://app.example.com/telegram/webhook" }),
      ],
    }),
  ],
});
```

`telegramAdapter()` with no args runs in long-polling mode. Pass `webhookUrl` to switch to webhook mode — nitro-bot auto-mounts the receiving route at `/telegram/webhook` (override with `webhookPath`).

For other platforms (Slack, Discord, …), use the generic `adapter()` helper until a dedicated wrapper is added:

```ts
import { adapter } from "@elumixor/nitro-bot";

adapter({
  name: "slack",
  from: "@chat-adapter/slack",
  factory: "createSlackAdapter",
  options: { /* whatever createSlackAdapter expects */ },
  webhookPath: "/slack/events",
})
```

Why the indirection? Adapter instances need to be constructed at runtime, but `nitro.config.ts` is build-time code. The helpers return a serializable descriptor that nitro-bot emits into a generated runtime file.

The bot responds to DMs and `@`-mentions, and stays subscribed to the thread after the first reply. Available chat-adapter packages: `telegram`, `slack`, `discord`, `teams`, `gchat`, `github`, `linear`, `whatsapp`.

State defaults to in-memory (subscriptions reset on restart). Persistent state isn't yet wired through the inline config — drop into a runtime plugin if you need it before that lands.

## What's next

Streaming, subagents, file attachments, and more chat-platform adapters (Slack / Discord / Teams) are on the roadmap.
