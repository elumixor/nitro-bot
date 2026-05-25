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

You get a `/chat` endpoint automatically:

```bash
curl -X POST localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what is the weather in berlin"}'
```

## Configuration

`chat.config.ts` accepts:

- `endpoint` (default `"/chat"`)
- `systemPrompt`
- `model` — any AI SDK `LanguageModel` (default `"anthropic/claude-sonnet-4.6"` via the Vercel AI Gateway)
- `maxSteps` (default `8`)

Set `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or your provider's key in your environment.

## What's next

Streaming, subagents, file attachments, and chat-platform adapters (Telegram / Slack / Discord) are on the roadmap.
