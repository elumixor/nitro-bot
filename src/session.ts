import type { ModelMessage } from "ai";
import type { H3Event } from "h3";
import type { NitroBotContext } from "./types";

/**
 * What `resolve()` returns for a single HTTP chat request: who the user is, which server-side
 * conversation this turn belongs to, the system prompt for this turn, and any extra context that
 * should be visible to tool routes on `event.context`.
 */
export type ChatSessionResolved = {
  /** Stable id of the conversation this turn belongs to. History is loaded/saved against it. */
  conversationId: string;
  /** System prompt for this turn (built from app state — current draft, available templates, …). */
  systemPrompt?: string;
  /** Identity surfaced to the agent/tools. Maps onto `BotContext.user`. */
  user?: { id: string; username?: string; firstName?: string; lastName?: string };
  /**
   * Extra fields merged onto `BotContext.context`, which the generated handler copies onto
   * `event.context`. Tool routes read them the normal Nitro way (e.g. `event.context.threadId`).
   */
  context?: NitroBotContext;
};

/**
 * Server-side session hooks for the HTTP `/chat` endpoint. The frontend sends only `{ <field>, ... }`;
 * the server owns auth, conversation identity, history, and persistence. Place the default export in the
 * file referenced by `nitroBotModule({ sessionFile })` (default `src/chat.ts`).
 */
export type ChatSessionDef = {
  /**
   * Authenticate the request and resolve the conversation. Receives the live h3 event (cookies, headers)
   * and the raw request body. Throw an h3 error (e.g. `createError({ statusCode: 401 })`) to reject.
   */
  resolve: (event: H3Event, body: Record<string, unknown>) => Promise<ChatSessionResolved> | ChatSessionResolved;
  /** Load prior messages for the conversation (oldest → newest). Omit for a stateless single-turn chat. */
  loadHistory?: (resolved: ChatSessionResolved, event: H3Event) => Promise<ModelMessage[]> | ModelMessage[];
  /** Persist the completed turn so the next request has context. Errors are logged, not surfaced. */
  save?: (
    resolved: ChatSessionResolved,
    turn: { user: string; assistant: string },
    event: H3Event,
  ) => Promise<void> | void;
};

/** Identity helper that types the default export of the session file. */
export function defineChatSession(def: ChatSessionDef): ChatSessionDef {
  return def;
}
