import type { LanguageModel } from "ai";

export type RequestSource = "query" | "json" | "form";

export type ChatConfig = {
  endpoint?: string;
  source?: RequestSource;
  field?: string;
  systemPrompt?: string;
  model?: LanguageModel;
  maxSteps?: number;
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
