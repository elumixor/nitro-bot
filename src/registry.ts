import type { Bot } from "grammy";

export type BotEntry = {
  bot: Bot;
  /** Present only in webhook mode — feeds an incoming HTTP request to grammy. */
  handleUpdate?: (req: Request) => Promise<Response>;
};

const registry = new Map<string, BotEntry>();

export function registerBot(name: string, entry: BotEntry): void {
  registry.set(name, entry);
}

/** Reach a running bot from anywhere (routes, webhooks, plugins). Omit `name` to get the first one. */
export function getBot(name?: string): BotEntry | undefined {
  if (name) return registry.get(name);
  return registry.values().next().value;
}
