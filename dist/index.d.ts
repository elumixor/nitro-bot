import { i as BotToolDefinition, p as HttpMethod, C as ChatConfig, m as ChatSessionDef, D as ToolRoute, A as AgentEvent } from './shared/nitro-bot.CuJYTuty.js';
export { a as AgentEventStreamOptions, b as AnyBotTool, B as BotAttachment, c as BotCommandDef, d as BotContext, e as BotEntry, f as BotHistory, g as BotPostFn, h as BotPreFn, j as ChatOptions, k as ChatReply, l as ChatResponse, n as ChatSessionResolved, o as CommandContext, H as HistoryMessage, I as InvokeFn, N as NitroBotContext, O as OutputGuard, q as OutputGuardInput, R as RequestSource, r as ResolvedChatConfig, s as RunAgentOptions, t as RunAgentResult, S as SessionChatOptions, u as StreamAgentOptions, v as SubagentDefinition, T as TelegramBotConfig, w as TelegramBotInfo, x as TelegramWebhookConfig, y as ToolDefinition, z as ToolInput, E as botCommand, G as botPost, J as botPre, K as botTool, L as buildBotToolSet, M as buildToolSet, P as createChatHandler, Q as createSessionChatHandler, U as defaultInvoke, V as defineChatSession, W as defineSubagent, X as defineTelegramBot, Y as getBot, Z as getBotContext, _ as isBotToolDefinition, $ as isSubagentDefinition, a0 as isToolDefinition, a1 as registerBot, a2 as resolveChatConfig, a3 as runAgent, a4 as runAgentEventStream, a5 as runAgentStream, a6 as tool } from './shared/nitro-bot.CuJYTuty.js';
import { z } from 'zod';
import { LanguageModel } from 'ai';
import { H3Event } from 'h3';
import 'grammy';
import 'grammy/types';
import 'node:async_hooks';

/**
 * Built-in tool auto-registered for Telegram bots (opt out via `builtins: { sendFile: false }`).
 * Mirrors the old hidden `SendFile`: a domain tool returns a file path, the model then calls this to
 * deliver it to the chat. Sends from disk so big blobs never round-trip through the model context.
 */
declare const sendFileBuiltin: BotToolDefinition<{
    path: z.ZodString;
    filename: z.ZodNullable<z.ZodString>;
    type: z.ZodEnum<{
        document: "document";
        photo: "photo";
    }>;
}>;

/** An imported symbol referenced inside a route's body/query schema (e.g. a Prisma enum), re-emitted into the generated handler. */
type SchemaImport = {
    name: string;
    /** Module to import from — bare/aliased specifiers (`services/prisma`) kept verbatim; relative ones resolved to absolute. */
    specifier: string;
};
type ExtractedSchema = {
    bodyText?: string;
    queryText?: string;
    imports?: SchemaImport[];
};
type RouteParam = {
    /** The dynamic segment name — `id` for `[id]`, `statusId` for `[statusId]`. */
    name: string;
    /** Nearest static path segment before the param — `people` for `people/[id]`. Used in the LLM description. */
    collection: string;
};
type DiscoveredRoute = {
    method: HttpMethod;
    path: string;
    absPath: string;
    params: RouteParam[];
    schema?: ExtractedSchema;
};
declare function discoverToolRoutes(routesDir: string): Promise<DiscoveredRoute[]>;

type NitroModuleHooks = {
    hook: (name: string, fn: () => void | Promise<void>) => void;
};
type NitroLike = {
    options: {
        rootDir: string;
        srcDir: string;
        buildDir: string;
        handlers: Array<{
            route: string;
            method?: string;
            handler: string;
        }>;
        plugins: string[];
        alias: Record<string, string>;
    };
    hooks: NitroModuleHooks;
};
type NitroBotModuleOptions = ChatConfig;
declare function nitroBotModule(config?: NitroBotModuleOptions): (nitro: NitroLike) => Promise<void>;

type RunAgentSessionOptions = {
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
declare function runAgentSession(opts: RunAgentSessionOptions): AsyncGenerator<AgentEvent, {
    steps: number;
}>;

export { AgentEvent, BotToolDefinition, ChatConfig, ChatSessionDef, HttpMethod, ToolRoute, discoverToolRoutes, nitroBotModule, runAgentSession, sendFileBuiltin };
export type { DiscoveredRoute, NitroBotModuleOptions, RunAgentSessionOptions };
