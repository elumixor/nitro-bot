import type { LanguageModel } from "ai";

export type ChatMethod = "GET" | "POST";

export type ChatConfig = {
  endpoint?: string;
  method?: ChatMethod;
  promptField?: string;
  systemPrompt?: string;
  model?: LanguageModel;
  maxSteps?: number;
};

export type ResolvedChatConfig = Required<
  Pick<ChatConfig, "endpoint" | "method" | "promptField" | "maxSteps" | "model">
> &
  Pick<ChatConfig, "systemPrompt">;

export const DEFAULT_CONFIG: ResolvedChatConfig = {
  endpoint: "/chat",
  method: "POST",
  promptField: "message",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
};

export function defineChatConfig(config: ChatConfig): ChatConfig {
  return config;
}

export function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  merged.method = (merged.method.toUpperCase() as ChatMethod) ?? "POST";
  return merged;
}
