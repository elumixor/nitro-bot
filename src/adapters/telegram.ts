import type { Bot } from "grammy";

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
};

/** Identity helper that types the default export of `src/bots/telegram/bot.ts`. */
export function defineTelegramBot(config: TelegramBotConfig): TelegramBotConfig {
  return config;
}
