# @elumixor/nitro-bot

Turn your Nitro routes into LLM tools, and get a `/chat` endpoint for free.

## Idea

You already have a Nitro server. Some routes do useful things (fetch weather, run a calculation, query your DB). Mark them as tools, and this library exposes a chat endpoint that lets an LLM call them on the user's behalf.

```ts
// src/routes/weather.get.ts
import { tool } from "@elumixor/nitro-bot";
import { z } from "zod";
import { handler } from "../utils/handler";

export const definition = tool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  input: { city: z.string() },
});

export default handler({ query: { city: z.string() } }, async ({ query }) => {
  return { city: query.city, tempCelsius: 21 };
});
```

```ts
// src/routes/chat.post.ts
import { createChatHandler } from "@elumixor/nitro-bot";
import * as weather from "./weather.get";

export default createChatHandler({
  tools: [{ method: "GET", path: "/weather", module: weather }],
});
```

```bash
curl -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"what is the weather in berlin"}'
```

## Install

```bash
bun add @elumixor/nitro-bot
```

Requires `h3` and `zod` as peer dependencies (you already have them in any Nitro project).

## Config

```ts
createChatHandler({
  tools: [...],
  model: "anthropic/claude-sonnet-4.6", // default
  systemPrompt: "You are a helpful assistant.",
  maxSteps: 8, // default
});
```

Set `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or `ANTHROPIC_API_KEY` in your environment.

## Status

Minimum-viable. Auto-discovery of tool routes, streaming, subagents, file attachments, and chat-platform adapters (Telegram/Slack/Discord) are next.
