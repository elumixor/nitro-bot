import type { LanguageModel } from "ai";

export type RequestSource = "query" | "json" | "form";

export type TelegramConfig = {
  /** Bot token from BotFather. Defaults to TELEGRAM_BOT_TOKEN env var. */
  token?: string;
  /**
   * If set, register a webhook at this path (relative to your server root)
   * and let Telegram push updates to it. If absent, the bot uses long polling.
   */
  webhookPath?: string;
  /** Optional X-Telegram-Bot-Api-Secret-Token. Defaults to TELEGRAM_WEBHOOK_SECRET_TOKEN env var. */
  secretToken?: string;
};

export type ChatConfig = {
  endpoint?: string;
  source?: RequestSource;
  field?: string;
  systemPrompt?: string;
  model?: LanguageModel;
  maxSteps?: number;
  telegram?: TelegramConfig;
};

export type ResolvedChatConfig = Required<Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model">> &
  Pick<ChatConfig, "systemPrompt">;

export const DEFAULT_CONFIG: ResolvedChatConfig = {
  endpoint: "/chat",
  source: "json",
  field: "message",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
};

export function defineChatConfig(config: ChatConfig): ChatConfig {
  return config;
}

export function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

export function httpMethodFor(source: RequestSource): "GET" | "POST" {
  return source === "query" ? "GET" : "POST";
}
