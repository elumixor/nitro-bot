import type { ToolSet } from "ai";

// Provider-/gateway-executed tools (e.g. `gateway.tools.perplexitySearch()`, `google.tools.googleSearch()`)
// don't fit the route-tool shape — they have no in-process handler and run server-side at the provider — so
// they can't ride the discovered tool routes, and they can't ride the serialized nitro-bot config either
// (they're live objects, not JSON). Instead a bot registers them once at startup (e.g. from a nitro plugin)
// and every transport merges them into the agent's tool set at request time via {@link getProviderTools}.
//
// The registry is read lazily (per turn), so registration order vs. handler setup doesn't matter — as long
// as it runs before the first request, which a nitro plugin guarantees.
let providerTools: ToolSet = {};

/** Register provider-/gateway-executed tools to be merged into every agent turn (web + Telegram). */
export function registerProviderTools(tools: ToolSet): void {
  providerTools = { ...providerTools, ...tools };
}

/** The currently registered provider tools. Merged into the agent's tool set on each turn. */
export function getProviderTools(): ToolSet {
  return providerTools;
}
