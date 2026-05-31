import { AsyncLocalStorage } from "node:async_hooks";
import type { BotContext } from "./types";

export const botContextStorage = new AsyncLocalStorage<BotContext>();

/** Read the current BotContext inside any code reached by an agent invocation (tool routes, sub-handlers, etc.). */
export function getBotContext(): BotContext | undefined {
  return botContextStorage.getStore();
}
