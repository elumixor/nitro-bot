import type { BotContext } from "./types";

export type CommandContext = BotContext & {
  /** Text after the command, trimmed (e.g. "/pay 100 usd" → "100 usd"). */
  args: string;
  /** Invoke a route tool by name directly (bypasses the LLM). Returns its raw result. */
  invokeTool: (name: string, input?: unknown) => Promise<unknown>;
};

export type BotCommandDef = {
  /** Command name without the leading slash. Optional — defaults to the file name (`me.ts` → "me"). */
  name?: string;
  /** Shown in Telegram's command menu and in /help. */
  description: string;
  /** Runs when the command is invoked — NOT routed through the agent. Return markdown to send. */
  run: (ctx: CommandContext) => string | Promise<string>;
};

/** Identity helper that types the default export of `src/bots/<name>/commands/*.ts`. */
export function botCommand(def: BotCommandDef): BotCommandDef {
  return def;
}
