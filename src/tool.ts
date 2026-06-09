import type { z } from "zod";

export const TOOL_BRAND = Symbol.for("nitro-bot.tool");

export type ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
  readonly [TOOL_BRAND]: true;
  name: string;
  description: string;
  input: I;
  /** When true, the call is not surfaced in the reply's `🔧 <name>` trail. */
  hidden?: boolean;
  /**
   * Assigns this tool to a subagent (see {@link defineSubagent}). The coordinator reaches it only by
   * delegating to that subagent. Omit to keep the tool shared — available to the coordinator and every
   * subagent. Ignored when the bot declares no subagents.
   */
  subagent?: string;
};

export type ToolInput<T> = T extends ToolDefinition<infer I> ? I : never;

export function tool<I extends z.ZodRawShape = Record<string, never>>(def: {
  name: string;
  description: string;
  input?: I;
  /** When true, hide this tool's call from the reply's `🔧 <name>` trail (the model still calls it normally). */
  hidden?: boolean;
  /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
  subagent?: string;
}): ToolDefinition<I> {
  return {
    [TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? ({} as I),
    hidden: def.hidden,
    subagent: def.subagent,
  };
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[TOOL_BRAND] === true;
}
