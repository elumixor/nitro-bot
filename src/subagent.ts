export const SUBAGENT_BRAND = Symbol.for("nitro-bot.subagent");

/**
 * A focused agent that owns a subset of the bot's tools. The coordinator (the bot's top-level agent)
 * sees one `delegate_to_<name>` tool per subagent — its `description` is the routing signal — and hands
 * a self-contained task to it. The subagent then runs its own agent loop over only its tools (plus the
 * shared, untagged tools), keeping the coordinator's tool surface small.
 *
 * Declare these under `src/bots/<name>/subagents/*.ts`; the file name is the default `name`
 * (`subagents/time.ts` → "time"), overridable by setting `name` explicitly. Tag a route/bot tool into a
 * subagent with `subagent: "<name>"` on its `tool({...})` / `botTool({...})` definition.
 */
export type SubagentDefinition = {
  readonly [SUBAGENT_BRAND]: true;
  /** Group key. Tools tagged `subagent: "<name>"` belong to this subagent. Defaults to the file name. */
  name: string;
  /** Shown to the coordinator as the `delegate_to_<name>` tool description — make it a clear routing signal. */
  description: string;
  /** System prompt for the subagent's own loop. Falls back to a generic instruction when omitted. */
  systemPrompt?: string;
  /** Gateway model id override (defaults to the bot's model). */
  model?: string;
  /** Max agent steps for the subagent's own loop (defaults to the bot's maxSteps). */
  maxSteps?: number;
};

export function defineSubagent(def: {
  name?: string;
  description: string;
  systemPrompt?: string;
  model?: string;
  maxSteps?: number;
}): SubagentDefinition {
  return {
    [SUBAGENT_BRAND]: true,
    name: def.name ?? "",
    description: def.description,
    systemPrompt: def.systemPrompt,
    model: def.model,
    maxSteps: def.maxSteps,
  };
}

export function isSubagentDefinition(value: unknown): value is SubagentDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SUBAGENT_BRAND] === true;
}
