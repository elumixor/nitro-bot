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
      /** Forum-topic id (`message_thread_id`) when the message is in a topic; undefined otherwise. */
      topicId?: number;
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

/** Chat-platform side effects a bot-local tool can trigger (sending files/photos to the thread). */
export type ChatReply = {
  sendDocument: (data: Uint8Array | Buffer, filename: string, caption?: string) => Promise<void>;
  sendPhoto: (data: Uint8Array | Buffer, caption?: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  /**
   * React to the triggering message with an emoji (Telegram `setMessageReaction`). Telegram only
   * accepts a fixed set of reaction emojis (e.g. 👍 👌 🎉 🙏 💯 — `✅` is NOT allowed); an invalid
   * emoji silently falls back to 👍. Defaults to 👍.
   */
  react: (emoji?: string) => Promise<void>;
};

export type BotContext<C extends Record<string, unknown> = NitroBotContext> = {
  bot: { name: string; username?: string };
  message: {
    text: string;
    id: number;
    replyToId?: number;
    /** Text (or caption) of the replied-to message, if this message is a reply. */
    replyToText?: string;
    /** Sender id of the replied-to message, if this message is a reply. */
    replyToFromId?: string;
    /** Display name (first+last, or username) of the replied-to message's sender. */
    replyToFromName?: string;
    /** True when this message replies directly to one of the bot's own messages. */
    repliesToBot?: boolean;
  };
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
    /** Forum-topic id (`message_thread_id`) when the message is in a topic; undefined otherwise. */
    topicId?: number;
  };
  agent: {
    messages: ModelMessage[];
    /** Set this in pre-middleware (`ctx.agent.systemPrompt = "..."`) — passed to the model as the
     *  dedicated `system` prompt, never interleaved into `messages`. */
    systemPrompt?: string;
    result?: { text: string; steps: number };
    /** Set by the renderer; subagent tool calls report a `↳ 🔧 name` trail line through it. Internal. */
    reportToolLine?: (line: string) => void;
  };
  /** Send files/photos/text to the current thread. Available inside bot-local tools and middleware. */
  reply: ChatReply;
  context: C;
};

export type BotPreFn<C extends Record<string, unknown> = NitroBotContext> = (
  ctx: BotContext<C>,
  // biome-ignore lint/suspicious/noConfusingVoidType: a middleware may return void (continue), false (halt), or a promise of either; `undefined` would reject consumers' `Promise<void>` callbacks
) => Promise<void | false> | void | false;

export type BotPostFn<C extends Record<string, unknown> = NitroBotContext> = (
  ctx: BotContext<C> & { agent: { messages: ModelMessage[]; result: { text: string; steps: number } } },
) => Promise<void> | void;

/** Identity helper that types a pre-middleware function. Return `false` to halt without replying. */
export const botPre = <C extends Record<string, unknown> = NitroBotContext>(fn: BotPreFn<C>): BotPreFn<C> => fn;

/** Identity helper that types a post-middleware function. Errors are swallowed and logged. */
export const botPost = <C extends Record<string, unknown> = NitroBotContext>(fn: BotPostFn<C>): BotPostFn<C> => fn;
