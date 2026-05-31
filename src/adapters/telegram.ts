import type { Bot } from "grammy";

export type TelegramBotConfig = {
  /** Live grammy Bot instance. Construct it here so the consumer keeps full control. */
  bot: Bot;
  /** Displayed as `ctx.bot.name`. Falls back to grammy's `botInfo.first_name` after start. */
  name?: string;
  /**
   * Use Telegram's `sendMessageDraft` streaming when eligible (text-only, private chat).
   * Defaults to `true`. Falls back to edit-loop for ineligible cases.
   */
  draftStreaming?: boolean;
};

/** Identity helper that types the default export of `src/bots/telegram/bot.ts`. */
export function defineTelegramBot(config: TelegramBotConfig): TelegramBotConfig {
  return config;
}
