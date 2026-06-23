import type { LanguageModel, ModelMessage } from "ai";
import type { H3Event } from "h3";
import { type AgentEvent, runAgentEventStream } from "./agent-stream";
import { buildToolSet, defaultInvoke, type ToolRoute } from "./chat-handler";
import { getProviderTools } from "./provider-tools";
import type { ChatSessionDef } from "./session";

export type RunAgentSessionOptions = {
  /** Server-side session hooks: resolve (auth + conversation), loadHistory, save. */
  session: ChatSessionDef;
  /** Live h3 event — passed to the session hooks so they can read cookies/headers. */
  event: H3Event;
  /** The user's message for this turn. */
  message: string;
  /**
   * The full parsed request body, forwarded verbatim to `session.resolve` (so it can read app-specific
   * fields like a thread/conversation id the client sent alongside the message). Defaults to `{ message }`.
   */
  body?: Record<string, unknown>;
  /** Discovered tool routes (from `#nitro-bot`). */
  toolRoutes: ToolRoute[];
  model: LanguageModel;
  maxSteps?: number;
};

/**
 * Generator-shaped, server-side-session chat turn. The streaming twin of
 * {@link import("./session-handler").createSessionChatHandler}: instead of mounting an SSE endpoint, it
 * `yield`s {@link AgentEvent}s and `return`s `{ steps }`, so a consumer can `yield*` it straight out of a
 * `@elumixor/nitro-client` `handler(async function* …)` route and get a fully typed client `Stream` —
 * keeping the chat logic in the library while the consumer owns only a thin, statically-typed shim.
 *
 * It resolves the request to a conversation, loads its history, runs the agent loop with the route tools
 * (inside `botContextStorage`, via `runAgentEventStream`, so tool routes read `event.context`), then
 * persists the turn.
 */
export async function* runAgentSession(opts: RunAgentSessionOptions): AsyncGenerator<AgentEvent, { steps: number }> {
  const { session, event, message, toolRoutes, model, maxSteps } = opts;

  const resolved = await session.resolve(event, opts.body ?? { message });
  const history = (await session.loadHistory?.(resolved, event)) ?? [];

  const messages: ModelMessage[] = [...history];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== message) messages.push({ role: "user", content: message });

  const result = yield* runAgentEventStream({
    messages,
    tools: { ...buildToolSet(toolRoutes, defaultInvoke), ...getProviderTools() },
    model,
    maxSteps,
    systemPrompt: resolved.systemPrompt,
    conversationId: resolved.conversationId,
    user: resolved.user,
    context: resolved.context,
  });

  if (session.save) {
    try {
      await session.save(resolved, { user: message, assistant: result.text }, event);
    } catch (error) {
      console.error("[nitro-bot] chat session save failed:", error);
    }
  }

  return { steps: result.steps };
}
