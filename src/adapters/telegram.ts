import type { Bot } from "grammy";
import type { BotContext } from "../types";

/** Input handed to an `OutputGuard.check` for one not-yet-sent slice of the assistant's reply. */
export type OutputGuardInput = {
  /** A completed slice of the reply (whole sentences/lines) that has NOT been sent to the chat yet. */
  chunk: string;
  /** Text already cleared and sent before this chunk — pass as context so cross-chunk leaks are caught. */
  precedingText: string;
  /** Live bot context (chat type, user, thread, …). */
  ctx: BotContext;
};

/**
 * Streaming output guard. When `active(ctx)` is true for a reply, nitro-bot buffers the streamed answer
 * and runs each completed chunk through `check` BEFORE it is sent to the chat — so sensitive content is
 * redacted *before* the user ever sees it (no send-then-edit). When `active` is false the reply streams
 * normally (draft streaming intact). Inactive replies never call `check`.
 */
export type OutputGuard = {
  /** Cheap, synchronous decision: gate this reply at all? (e.g. only in group/supergroup chats.) */
  active: (ctx: BotContext) => boolean;
  /** Return the safe version of `chunk` (verbatim when nothing is sensitive). Runs before the chunk is sent. */
  check: (input: OutputGuardInput) => Promise<string>;
};

export type TelegramWebhookConfig = {
  /** Public URL Telegram should POST updates to. Must resolve to this app's `/<botName>/webhook` route. */
  url: string;
  /** Optional secret token; validated by grammy's webhook callback. */
  secret?: string;
};

export type TelegramBotInfo = { id: number; username?: string; name: string };

export type TelegramBotConfig = {
  /**
   * Bot token — nitro-bot constructs the grammy `Bot` for you. Prefer this: it avoids the
   * dual-package type clash you hit when a linked/duplicate `grammy` builds the instance.
   * Provide either `token` or `bot`.
   */
  token?: string;
  /** Live grammy Bot instance, if you need full control (custom middleware, transformers, …). */
  bot?: Bot;
  /** Displayed as `ctx.bot.name`. Falls back to grammy's `botInfo.first_name` after start. */
  name?: string;
  /**
   * Use Telegram's `sendMessageDraft` streaming when eligible (text-only, private chat).
   * Defaults to `true`. Falls back to edit-loop for ineligible cases.
   */
  draftStreaming?: boolean;
  /**
   * Run the bot in webhook mode instead of long-polling. nitro-bot mounts the receiving route at
   * `/<botName>/webhook` (e.g. `/telegram/webhook`); point `url` at that path on your public host.
   */
  webhook?: TelegramWebhookConfig;
  /**
   * Called once after the bot is initialized (botInfo available) but before it starts handling
   * updates. Use for app bootstrap: DB migrations, warming caches, syncing remote config, etc.
   */
  onStart?: (ctx: { bot: Bot; info: TelegramBotInfo }) => void | Promise<void>;
  /**
   * Built-in tools auto-provided to this bot (both default on). `sendFile` lets the model deliver files;
   * `react` lets it acknowledge a message with an emoji reaction.
   */
  builtins?: { sendFile?: boolean; react?: boolean };
  /**
   * Optional streaming output guard. When `active(ctx)` is true, the assistant's reply is buffered and
   * each completed chunk is passed through `check` before being sent — redacting sensitive content in
   * place without ever sending-then-editing. Use it to scrub e.g. internal ids / pay / PII out of group
   * replies while leaving private (admin) chats untouched.
   */
  guard?: OutputGuard;
};

/** Identity helper that types the default export of `src/bots/telegram/bot.ts`. */
export function defineTelegramBot(config: TelegramBotConfig): TelegramBotConfig {
  return config;
}
