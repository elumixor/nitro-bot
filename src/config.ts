import type { LanguageModel } from "ai";

export type RequestSource = "query" | "json" | "form";

export type ChatConfig = {
  /** HTTP endpoint mounted on the Nitro app for the plain JSON chat API. */
  endpoint?: string;
  source?: RequestSource;
  field?: string;
  model?: LanguageModel;
  maxSteps?: number;
  /** System prompt for the HTTP `/chat` endpoint. (Bots set their own via pre-middleware.) */
  systemPrompt?: string;
  /** Directory scanned for bot definitions. Defaults to `src/bots`. */
  botsDir?: string;
  /**
   * Path (relative to the Nitro root) to a server-side chat-session file whose default export is a
   * {@link import("./session").ChatSessionDef} (via `defineChatSession`). When set, the `/chat` endpoint
   * is backed by that session — server-owned history, auth, and per-conversation tool context — instead
   * of the stateless single-message handler.
   */
  sessionFile?: string;
  /** Stream the `/chat` reply as Server-Sent Events (`data: {delta}` / `{done}` / `{error}`). */
  stream?: boolean;
};

export type ResolvedChatConfig = Required<
  Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model" | "botsDir" | "stream">
> &
  Pick<ChatConfig, "systemPrompt" | "sessionFile">;

export const DEFAULT_CONFIG: ResolvedChatConfig = {
  endpoint: "/chat",
  source: "json",
  field: "message",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
  botsDir: "src/bots",
  stream: false,
};

export function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}
