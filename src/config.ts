import type { LanguageModel } from "ai";

export type RequestSource = "query" | "json" | "form";

export type ChatConfig = {
  /** HTTP endpoint mounted on the Nitro app for the plain JSON chat API. */
  endpoint?: string;
  source?: RequestSource;
  field?: string;
  model?: LanguageModel;
  maxSteps?: number;
  /** Directory scanned for bot definitions. Defaults to `src/bots`. */
  botsDir?: string;
};

export type ResolvedChatConfig = Required<
  Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model" | "botsDir">
>;

export const DEFAULT_CONFIG: ResolvedChatConfig = {
  endpoint: "/chat",
  source: "json",
  field: "message",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
  botsDir: "src/bots",
};

export function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}
