import { tool as aiTool, type ToolSet } from "ai";
import { z } from "zod";
import { getBotContext } from "./als";
import type { BotContext } from "./types";

export const BOT_TOOL_BRAND = Symbol.for("nitro-bot.bot-tool");

/**
 * A tool that only makes sense inside a chat (it sends files, reacts, reads thread state) and so
 * isn't an HTTP route. Define these under `src/bots/<name>/tools/*.ts`; nitro-bot discovers them and
 * exposes them to that bot's agent alongside the route tools. `execute` receives the live
 * {@link BotContext}, including `ctx.reply.sendDocument(...)`.
 */
export type BotToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
  readonly [BOT_TOOL_BRAND]: true;
  name: string;
  description: string;
  input: I;
  /** When true, the call is not surfaced in the reply's `🔧 <name>` trail (e.g. `react`). */
  hidden?: boolean;
  /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
  subagent?: string;
  execute: (input: z.infer<z.ZodObject<I>>, ctx: BotContext) => unknown | Promise<unknown>;
};

export function botTool<I extends z.ZodRawShape = Record<string, never>>(def: {
  name: string;
  description: string;
  /** Use `.nullable()` (not `.optional()`) for optional fields — LLM tool schemas reject optional. */
  input?: I;
  /** When true, hide this tool's call from the reply's `🔧 <name>` trail (the model still calls it normally). */
  hidden?: boolean;
  /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
  subagent?: string;
  execute: (input: z.infer<z.ZodObject<I>>, ctx: BotContext) => unknown | Promise<unknown>;
}): BotToolDefinition<I> {
  return {
    [BOT_TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? ({} as I),
    hidden: def.hidden,
    subagent: def.subagent,
    execute: def.execute,
  };
}

export function isBotToolDefinition(value: unknown): value is BotToolDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BOT_TOOL_BRAND] === true;
}

/**
 * A bot tool with its input type erased so heterogeneous tools live in one array. `execute(input: never)`
 * makes every concrete `BotToolDefinition<I>` assignable here (contravariance).
 */
export type AnyBotTool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  hidden?: boolean;
  subagent?: string;
  execute: (input: never, ctx: BotContext) => unknown | Promise<unknown>;
};

/** Convert bot-local tool definitions into an AI SDK ToolSet that pulls the live BotContext at call time. */
export function buildBotToolSet(defs: readonly AnyBotTool[]): ToolSet {
  const entries = defs.map((def) => {
    return [
      def.name,
      aiTool({
        description: def.description,
        inputSchema: z.object(def.input),
        execute: async (input: unknown) => {
          const ctx = getBotContext();
          if (!ctx) throw new Error(`[nitro-bot] bot tool "${def.name}" was called outside an active bot turn.`);
          return await def.execute(input as never, ctx);
        },
      }),
    ] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
}
