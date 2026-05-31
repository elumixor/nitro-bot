import type { ModelMessage } from "ai";

declare module "h3" {
  interface H3EventContext {
    /** Populated by nitro-bot's auto-generated middleware for tool invocations driven by the agent. */
    bot?: {
      threadId: string;
      threadName?: string;
      threadType: "private" | "group" | "supergroup" | "channel";
      userId: string;
      userName?: string;
      botName: string;
      botUsername?: string;
      messageId: number;
      replyToId?: number;
    };
  }
}

/**
 * User-augmentable shape of the `context` bag on `BotContext`. Augment via:
 *
 * ```ts
 * declare module "@elumixor/nitro-bot" {
 *   interface NitroBotContext {
 *     isAdmin?: boolean;
 *   }
 * }
 * export {};
 * ```
 */
export interface NitroBotContext extends Record<string, unknown> {}

export type BotContext<C extends Record<string, unknown> = NitroBotContext> = {
  bot: { name: string; username?: string };
  message: { text: string; id: number; replyToId?: number };
  user: {
    id: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
  };
  thread: {
    id: string;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
  };
  agent: {
    messages: ModelMessage[];
    result?: { text: string; steps: number };
  };
  context: C;
};

export type BotPreFn<C extends Record<string, unknown> = NitroBotContext> = (
  ctx: BotContext<C>,
) => Promise<void | false> | void | false;

export type BotPostFn<C extends Record<string, unknown> = NitroBotContext> = (
  ctx: BotContext<C> & { agent: { messages: ModelMessage[]; result: { text: string; steps: number } } },
) => Promise<void> | void;

/** Identity helper that types a pre-middleware function. Return `false` to halt without replying. */
export const botPre = <C extends Record<string, unknown> = NitroBotContext>(fn: BotPreFn<C>): BotPreFn<C> => fn;

/** Identity helper that types a post-middleware function. Errors are swallowed and logged. */
export const botPost = <C extends Record<string, unknown> = NitroBotContext>(fn: BotPostFn<C>): BotPostFn<C> => fn;
