import type { LanguageModel } from "ai";

export type ChatConfig = {
  endpoint?: string;
  systemPrompt?: string;
  model?: LanguageModel;
  maxSteps?: number;
};

export type ResolvedChatConfig = Required<Pick<ChatConfig, "endpoint" | "maxSteps">> &
  Omit<ChatConfig, "endpoint" | "maxSteps">;

export const DEFAULT_CONFIG: ResolvedChatConfig = {
  endpoint: "/chat",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
};

export function defineChatConfig(config: ChatConfig): ChatConfig {
  return config;
}

export function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}
