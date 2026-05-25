# Example

Tiny Nitro app demonstrating `@elumixor/nitro-bot`.

```bash
bun install
export AI_GATEWAY_API_KEY=...   # or ANTHROPIC_API_KEY=...
bun run dev
```

```bash
curl -X POST localhost:3456/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what is the weather in tokyo, and what is 17 + 4?"}'
```

You should see a single response that calls `get_weather` and `add` and summarises the result.
