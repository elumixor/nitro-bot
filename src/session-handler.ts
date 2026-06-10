import type { LanguageModel, ModelMessage } from "ai";
import { createError, defineEventHandler, type H3Event, readBody, setResponseHeader } from "h3";
import { runAgentStream } from "./agent";
import { botContextStorage } from "./als";
import { buildToolSet, defaultInvoke, type ToolRoute } from "./chat-handler";
import type { ChatSessionDef, ChatSessionResolved } from "./session";
import type { BotContext, ChatReply } from "./types";

export type SessionChatOptions = {
  session: ChatSessionDef;
  tools: ToolRoute[];
  model: LanguageModel;
  maxSteps: number;
  /** Body field carrying the user message (default `message`). */
  field?: string;
  /** Stream the reply as Server-Sent Events. When false, returns `{ text, steps }` once finished. */
  stream?: boolean;
};

// Web transport has no chat-platform side effects (no files/reactions). Tool routes that try to use
// `ctx.reply` over HTTP get harmless no-ops rather than a crash.
const noopReply: ChatReply = {
  sendDocument: async () => {},
  sendPhoto: async () => {},
  sendText: async () => {},
  react: async () => {},
};

function buildSessionContext(message: string, resolved: ChatSessionResolved, messages: ModelMessage[]): BotContext {
  return {
    bot: { name: "web" },
    message: { text: message, id: 0 },
    user: {
      id: resolved.user?.id ?? "",
      username: resolved.user?.username,
      firstName: resolved.user?.firstName,
      lastName: resolved.user?.lastName,
    },
    thread: { id: resolved.conversationId, type: "private" },
    agent: { messages, systemPrompt: resolved.systemPrompt },
    reply: noopReply,
    context: resolved.context ?? {},
  };
}

/**
 * HTTP `/chat` handler backed by server-side sessions (see {@link defineChatSession}). Resolves the
 * request to a conversation, loads its history, runs a streaming agent loop with the route tools, and
 * persists the turn. The agent runs inside `botContextStorage` so tool routes read `event.context`
 * (user, conversation, app-specific fields) just like the Telegram transport.
 */
export function createSessionChatHandler(options: SessionChatOptions) {
  const field = options.field ?? "message";
  const stream = options.stream ?? false;
  const toolSet = buildToolSet(options.tools, defaultInvoke);

  return defineEventHandler(async (event: H3Event) => {
    const body = ((await readBody(event)) ?? {}) as Record<string, unknown>;
    const message = body[field];
    if (typeof message !== "string" || message.trim().length === 0)
      throw createError({ statusCode: 400, statusMessage: `Field '${field}' is required.` });

    const resolved = await options.session.resolve(event, body);
    const history = (await options.session.loadHistory?.(resolved, event)) ?? [];

    const messages: ModelMessage[] = [...history];
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || last.content !== message) messages.push({ role: "user", content: message });

    const botCtx = buildSessionContext(message, resolved, messages);

    const run = (onDelta?: (delta: string) => void, onToolCall?: (name: string) => void) =>
      botContextStorage.run(botCtx, () =>
        runAgentStream({
          messages,
          tools: toolSet,
          model: options.model,
          systemPrompt: resolved.systemPrompt,
          maxSteps: options.maxSteps,
          onDelta,
          onToolCall,
        }),
      );

    if (!stream) {
      const result = await run();
      await persist(options.session, resolved, message, result.text, event);
      return { text: result.text, steps: result.steps };
    }

    setResponseHeader(event, "Content-Type", "text/event-stream");
    setResponseHeader(event, "Cache-Control", "no-cache, no-transform");
    setResponseHeader(event, "Connection", "keep-alive");
    setResponseHeader(event, "X-Accel-Buffering", "no");

    const encoder = new TextEncoder();
    const send = (controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const result = await run(
            (delta) => send(controller, { delta }),
            (name) => send(controller, { tool: name }),
          );
          await persist(options.session, resolved, message, result.text, event);
          send(controller, { done: true, steps: result.steps });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          send(controller, { error: errorMessage });
        } finally {
          controller.close();
        }
      },
    });
  });
}

async function persist(
  session: ChatSessionDef,
  resolved: ChatSessionResolved,
  user: string,
  assistant: string,
  event: H3Event,
): Promise<void> {
  if (!session.save) return;
  try {
    await session.save(resolved, { user, assistant }, event);
  } catch (error) {
    console.error("[nitro-bot] chat session save failed:", error);
  }
}
