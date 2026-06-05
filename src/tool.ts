import type { z } from "zod";

export const TOOL_BRAND = Symbol.for("nitro-bot.tool");

export type ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
  readonly [TOOL_BRAND]: true;
  name: string;
  description: string;
  input: I;
  /** When true, the call is not surfaced in the reply's `🔧 <name>` trail. */
  hidden?: boolean;
};

export type ToolInput<T> = T extends ToolDefinition<infer I> ? I : never;

export function tool<I extends z.ZodRawShape = Record<string, never>>(def: {
  name: string;
  description: string;
  input?: I;
  /** When true, hide this tool's call from the reply's `🔧 <name>` trail (the model still calls it normally). */
  hidden?: boolean;
}): ToolDefinition<I> {
  return {
    [TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? ({} as I),
    hidden: def.hidden,
  };
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[TOOL_BRAND] === true;
}
