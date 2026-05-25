# Example

Nitro app demonstrating `@elumixor/nitro-bot`. No hand-written chat route — the module discovers tool-marked routes and mounts `/chat` automatically.

```bash
bun install
export AI_GATEWAY_API_KEY=...   # or set in example/.env
bun run dev
```

```bash
curl -X POST localhost:3456/chat \
  -H 'content-type: application/json' \
  -d '{"message":"what is the weather in tokyo, and what is 17 + 4?"}'
```
