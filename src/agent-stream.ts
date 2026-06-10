import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { type RunAgentResult, runAgentStream } from "./agent";
import { botContextStorage } from "./als";
import type { BotContext, ChatReply, NitroBotContext } from "./types";

/** A single event from {@link runAgentEventStream}: a text chunk or a tool invocation. */
export type AgentEvent = { type: "delta"; text: string } | { type: "tool"; name: string };

export type AgentEventStreamOptions = {
  tools: ToolSet;
  model: LanguageModel;
  maxSteps?: number;
  systemPrompt?: string;
  /** Full conversation history including the current user turn. Takes precedence over `prompt`. */
  messages?: ModelMessage[];
  prompt?: string;
  /** Conversation id surfaced to tool routes as `event.context.bot.threadId`. */
  conversationId?: string;
  user?: { id: string; username?: string; firstName?: string; lastName?: string };
  /** Extra fields merged onto `event.context` for tool routes (e.g. the resolved app user, draft id). */
  context?: NitroBotContext;
};

const noopReply: ChatReply = {
  sendDocument: async () => {},
  sendPhoto: async () => {},
  sendText: async () => {},
  react: async () => {},
};

function buildWebBotContext(opts: AgentEventStreamOptions): BotContext | undefined {
  if (!opts.conversationId && !opts.user && !opts.context) return undefined;
  return {
    bot: { name: "web" },
    message: { text: "", id: 0 },
    user: {
      id: opts.user?.id ?? "",
      username: opts.user?.username,
      firstName: opts.user?.firstName,
      lastName: opts.user?.lastName,
    },
    thread: { id: opts.conversationId ?? "", type: "private" },
    agent: { messages: opts.messages ?? [], systemPrompt: opts.systemPrompt },
    reply: noopReply,
    context: opts.context ?? {},
  };
}

/**
 * Generator-shaped streaming agent loop: `yield`s {@link AgentEvent}s (text deltas and tool calls) and
 * `return`s the final `{ text, steps }`. Designed to be `yield*`-ed straight out of a streaming route
 * handler (e.g. `@elumixor/nitro-client`'s `handler(async function* …)`), giving a fully typed client
 * `Stream` without a hand-rolled `fetch`/SSE parser.
 *
 * When `conversationId`/`user`/`context` are provided it runs the agent inside `botContextStorage` so
 * tool routes read `event.context` exactly like the Telegram transport. The callback→generator bridge
 * keeps that ALS scope alive across the whole stream (tools execute inside it, the caller drains the
 * queue outside it).
 */
export async function* runAgentEventStream(opts: AgentEventStreamOptions): AsyncGenerator<AgentEvent, RunAgentResult> {
  const botCtx = buildWebBotContext(opts);

  const queue: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  const wake = () => {
    notify?.();
    notify = null;
  };
  const push = (event: AgentEvent) => {
    queue.push(event);
    wake();
  };

  let done = false;
  let error: unknown;
  let result: RunAgentResult | undefined;

  const exec = () =>
    runAgentStream({
      tools: opts.tools,
      model: opts.model,
      maxSteps: opts.maxSteps,
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      prompt: opts.prompt,
      onDelta: (text) => push({ type: "delta", text }),
      onToolCall: (name) => push({ type: "tool", name }),
    });

  const runner = (botCtx ? botContextStorage.run(botCtx, exec) : exec())
    .then((r) => {
      result = r;
    })
    .catch((e) => {
      error = e;
    })
    .finally(() => {
      done = true;
      wake();
    });

  let i = 0;
  while (true) {
    while (i < queue.length) {
      const event = queue[i++];
      if (event) yield event;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }

  await runner;
  if (error) throw error;
  return result ?? { text: "", steps: 0 };
}
