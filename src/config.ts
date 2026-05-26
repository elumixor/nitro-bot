import type { LanguageModel } from "ai";
import type { Adapter, StateAdapter } from "chat";

export type RequestSource = "query" | "json" | "form";

export type ChatConfig = {
  endpoint?: string;
  source?: RequestSource;
  field?: string;
  systemPrompt?: string;
  model?: LanguageModel;
  maxSteps?: number;
  /** Bot identity for the chat SDK (used by Slack/etc. mention parsing). */
  userName?: string;
  /** Platform adapters keyed by name. Construct in chat.config.ts so peer-dep imports stay in user code. */
  adapters?: Record<string, Adapter>;
  /** Optional webhook path per adapter name. Adapters without a path use polling/long-running mode. */
  webhooks?: Record<string, string>;
  /** State persistence for the chat SDK. Defaults to in-memory. */
  state?: StateAdapter;
};

export type ResolvedChatConfig = Required<Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model">> &
  Pick<ChatConfig, "systemPrompt" | "userName" | "adapters" | "webhooks" | "state">;

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
