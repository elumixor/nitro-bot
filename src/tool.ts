import type { z } from "zod";

export const TOOL_BRAND = Symbol.for("nitro-bot.tool");

export type SchemaShape = Record<string, z.ZodType>;

export type HandlerWithSchemas = {
  inputSchemas?: {
    body?: SchemaShape;
    query?: SchemaShape;
  };
};

export type ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
  readonly [TOOL_BRAND]: true;
  name: string;
  description: string;
  input: I;
};

export type ToolInput<T> = T extends ToolDefinition<infer I> ? I : never;

type ExplicitInput<I extends z.ZodRawShape> = {
  name: string;
  description: string;
  input?: I;
  from?: never;
};

type DerivedInput = {
  name: string;
  description: string;
  from: HandlerWithSchemas;
  input?: never;
};

export function tool<I extends z.ZodRawShape>(def: ExplicitInput<I>): ToolDefinition<I>;
export function tool(def: DerivedInput): ToolDefinition;
export function tool<I extends z.ZodRawShape>(def: ExplicitInput<I> | DerivedInput): ToolDefinition {
  const input = def.input ?? deriveFromHandler(def.from) ?? {};
  return {
    [TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: input as z.ZodRawShape,
  };
}

function deriveFromHandler(handler: HandlerWithSchemas | undefined): z.ZodRawShape | undefined {
  if (!handler?.inputSchemas) return undefined;
  const { body, query } = handler.inputSchemas;
  if (!body && !query) return {};
  return { ...(query ?? {}), ...(body ?? {}) };
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[TOOL_BRAND] === true;
}
