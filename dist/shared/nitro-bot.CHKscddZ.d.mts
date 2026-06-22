import { Bot } from 'grammy';
import { UserFromGetMe } from 'grammy/types';
import { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import * as h3 from 'h3';
import { EventHandler, H3Event } from 'h3';

/** A tool call to be described for the live `🔧` trail. */
type ToolCallInfo = {
    name: string;
    description?: string;
    input: unknown;
};
/** Turns a tool call into a short, human-readable status line (e.g. "Looking up Yehor"). */
type ToolLabeler = (call: ToolCallInfo) => Promise<string>;
/**
 * Build a labeler backed by a (cheap) model. Each call is one short `generateText`; on any failure the
 * caller falls back to the bare tool name, so labeling never blocks or breaks a reply.
 */
declare function makeToolLabeler(model: LanguageModel): ToolLabeler;

declare module "h3" {
    interface H3EventContext {
        /** Populated by nitro-bot's auto-generated middleware for tool invocations driven by the agent. */
        bot?: {
            threadId: string;
            threadName?: string;
            threadType: "private" | "group" | "supergroup" | "channel";
            userId: string;
            userName?: string;
            botName: string;
            botUsername?: string;
            messageId: number;
            replyToId?: number;
            /** Forum-topic id (`message_thread_id`) when the message is in a topic; undefined otherwise. */
            topicId?: number;
        };
    }
}
/**
 * User-augmentable shape of the `context` bag on `BotContext`. Augment via:
 *
 * ```ts
 * declare module "@elumixor/nitro-bot" {
 *   interface NitroBotContext {
 *     isAdmin?: boolean;
 *   }
 * }
 * export {};
 * ```
 */
interface NitroBotContext extends Record<string, unknown> {
}
/**
 * A file the user sent with their message, already downloaded from Telegram. Set on
 * `ctx.message.attachment` for `message:document` / `message:photo` updates. The same bytes are also
 * handed to the model as a multimodal content part, so the agent can *see* the file and decide which
 * tool to call; a tool's `execute` reads `ctx.message.attachment.bytes` to do the structured work.
 */
type BotAttachment = {
    /** Raw file bytes downloaded from Telegram. */
    bytes: Buffer;
    /** MIME type, e.g. `application/pdf` or `image/jpeg`. */
    mediaType: string;
    /** Original filename (documents) or a synthesized one (photos, e.g. `photo.jpg`). */
    filename: string;
    /** Which Telegram message kind this came from. */
    kind: "document" | "photo";
};
/** A stored prior message, returned by {@link BotHistory.search} and surfaced through the `search_history` tool. */
type HistoryMessage = {
    role: "user" | "assistant";
    content: string;
    at?: string;
};
/**
 * Server-owned conversation memory for a Telegram bot. nitro-bot calls `load` before each turn to seed
 * the agent, and `save` after the reply completes; `search` (when provided) backs a built-in
 * `search_history` tool the agent can call to look further back than the loaded window.
 */
type BotHistory<C extends Record<string, unknown> = NitroBotContext> = {
    /** Prior turns for this thread (oldest-first) to prepend before the current message. */
    load?: (ctx: BotContext<C>) => Promise<ModelMessage[]> | ModelMessage[];
    /** Persist one completed turn: the user's message text and the assistant's reply. */
    save?: (ctx: BotContext<C>, turn: {
        user: string;
        assistant: string;
    }) => Promise<void> | void;
    /** Search prior messages (backs the `search_history` tool). `limit` is always provided (defaulted). */
    search?: (args: {
        query?: string;
        limit: number;
    }, ctx: BotContext<C>) => Promise<HistoryMessage[]> | HistoryMessage[];
};
/** Chat-platform side effects a bot-local tool can trigger (sending files/photos to the thread). */
type ChatReply = {
    sendDocument: (data: Uint8Array | Buffer, filename: string, caption?: string) => Promise<void>;
    sendPhoto: (data: Uint8Array | Buffer, caption?: string) => Promise<void>;
    sendText: (text: string) => Promise<void>;
    /**
     * React to the triggering message with an emoji (Telegram `setMessageReaction`). Telegram only
     * accepts a fixed set of reaction emojis (e.g. 👍 👌 🎉 🙏 💯 — `✅` is NOT allowed); an invalid
     * emoji silently falls back to 👍. Defaults to 👍.
     */
    react: (emoji?: string) => Promise<void>;
};
type BotContext<C extends Record<string, unknown> = NitroBotContext> = {
    bot: {
        name: string;
        username?: string;
    };
    message: {
        text: string;
        id: number;
        replyToId?: number;
        /** Text (or caption) of the replied-to message, if this message is a reply. */
        replyToText?: string;
        /** Sender id of the replied-to message, if this message is a reply. */
        replyToFromId?: string;
        /** Display name (first+last, or username) of the replied-to message's sender. */
        replyToFromName?: string;
        /** True when this message replies directly to one of the bot's own messages. */
        repliesToBot?: boolean;
        /** Set for `message:document` / `message:photo` updates — the downloaded file (also shown to the model). */
        attachment?: BotAttachment;
    };
    user: {
        id: string;
        username?: string;
        firstName?: string;
        lastName?: string;
        languageCode?: string;
    };
    thread: {
        id: string;
        type: "private" | "group" | "supergroup" | "channel";
        title?: string;
        /** Forum-topic id (`message_thread_id`) when the message is in a topic; undefined otherwise. */
        topicId?: number;
    };
    agent: {
        messages: ModelMessage[];
        /** Set this in pre-middleware (`ctx.agent.systemPrompt = "..."`) — passed to the model as the
         *  dedicated `system` prompt, never interleaved into `messages`. */
        systemPrompt?: string;
        result?: {
            text: string;
            steps: number;
        };
        /** Set by the renderer; subagent tool calls report a `↳ 🔧 name` trail line through it. Internal. */
        reportToolLine?: (line: string) => void;
        /** Set by the bot when `labelModel` is configured; turns a tool call into a short trail label. Internal. */
        describeTool?: ToolLabeler;
    };
    /** Send files/photos/text to the current thread. Available inside bot-local tools and middleware. */
    reply: ChatReply;
    context: C;
};
type BotPreFn<C extends Record<string, unknown> = NitroBotContext> = (ctx: BotContext<C>) => Promise<void | false> | void | false;
type BotPostFn<C extends Record<string, unknown> = NitroBotContext> = (ctx: BotContext<C> & {
    agent: {
        messages: ModelMessage[];
        result: {
            text: string;
            steps: number;
        };
    };
}) => Promise<void> | void;
/** Identity helper that types a pre-middleware function. Return `false` to halt without replying. */
declare const botPre: <C extends Record<string, unknown> = NitroBotContext>(fn: BotPreFn<C>) => BotPreFn<C>;
/** Identity helper that types a post-middleware function. Errors are swallowed and logged. */
declare const botPost: <C extends Record<string, unknown> = NitroBotContext>(fn: BotPostFn<C>) => BotPostFn<C>;

/** Input handed to an `OutputGuard.check` for one not-yet-sent slice of the assistant's reply. */
type OutputGuardInput = {
    /** A completed slice of the reply (whole sentences/lines) that has NOT been sent to the chat yet. */
    chunk: string;
    /** Text already cleared and sent before this chunk — pass as context so cross-chunk leaks are caught. */
    precedingText: string;
    /** Live bot context (chat type, user, thread, …). */
    ctx: BotContext;
};
/**
 * Streaming output guard. When `active(ctx)` is true for a reply, nitro-bot buffers the streamed answer
 * and runs each completed chunk through `check` BEFORE it is sent to the chat — so sensitive content is
 * redacted *before* the user ever sees it (no send-then-edit). When `active` is false the reply streams
 * normally (draft streaming intact). Inactive replies never call `check`.
 */
type OutputGuard = {
    /** Cheap, synchronous decision: gate this reply at all? (e.g. only in group/supergroup chats.) */
    active: (ctx: BotContext) => boolean;
    /** Return the safe version of `chunk` (verbatim when nothing is sensitive). Runs before the chunk is sent. */
    check: (input: OutputGuardInput) => Promise<string>;
};
type TelegramWebhookConfig = {
    /** Public URL Telegram should POST updates to. Must resolve to this app's `/<botName>/webhook` route. */
    url: string;
    /** Optional secret token; validated by grammy's webhook callback. */
    secret?: string;
    /**
     * Await full update processing (the whole agent turn, including the streamed reply) before responding
     * 200 to Telegram, instead of acking immediately and processing in the background.
     *
     * **Required on serverless (Vercel, AWS Lambda, …).** There the instance is frozen the moment the HTTP
     * response is sent, so a backgrounded `bot.handleUpdate` — a multi-second streaming agent — is killed
     * mid-flight and the user never gets a reply. Awaiting keeps the function alive for the whole turn.
     * Duplicate redelivery (Telegram retries if the response is slow) is already guarded by the per-message
     * dedupe, so the cost is only that Telegram holds the connection open until the reply is done.
     *
     * Defaults to `false` (ack-then-background), which is correct on a long-lived server.
     */
    awaitProcessing?: boolean;
};
type TelegramBotInfo = {
    id: number;
    username?: string;
    name: string;
};
type TelegramBotConfig = {
    /**
     * Bot token — nitro-bot constructs the grammy `Bot` for you. Prefer this: it avoids the
     * dual-package type clash you hit when a linked/duplicate `grammy` builds the instance.
     * Provide either `token` or `bot`.
     */
    token?: string;
    /** Live grammy Bot instance, if you need full control (custom middleware, transformers, …). */
    bot?: Bot;
    /**
     * Pre-known bot identity (`id`, `username`, `first_name`, the bot capability flags). Provide this and
     * grammy never calls `getMe` — the bot can handle updates with zero network round-trips, so the webhook
     * receiver is registered immediately on boot.
     *
     * **Strongly recommended on serverless.** A cold Vercel/Lambda instance often fails its first outbound
     * request, so a `getMe`-on-boot would throw and leave that instance returning 503 to Telegram until it
     * warms. With `botInfo` set there's no such call, so every instance serves the webhook on first boot.
     */
    botInfo?: UserFromGetMe;
    /** Displayed as `ctx.bot.name`. Falls back to grammy's `botInfo.first_name` after start. */
    name?: string;
    /**
     * Use Telegram's `sendMessageDraft` streaming when eligible (text-only, private chat).
     * Defaults to `true`. Falls back to edit-loop for ineligible cases.
     */
    draftStreaming?: boolean;
    /**
     * Run the bot in webhook mode instead of long-polling. nitro-bot mounts the receiving route at
     * `/<botName>/webhook` (e.g. `/telegram/webhook`); point `url` at that path on your public host.
     */
    webhook?: TelegramWebhookConfig;
    /**
     * Called once after the bot is initialized (botInfo available) but before it starts handling
     * updates. Use for app bootstrap: DB migrations, warming caches, syncing remote config, etc.
     */
    onStart?: (ctx: {
        bot: Bot;
        info: TelegramBotInfo;
    }) => void | Promise<void>;
    /**
     * Built-in tools auto-provided to this bot (both default on). `sendFile` lets the model deliver files;
     * `react` lets it acknowledge a message with an emoji reaction.
     */
    builtins?: {
        sendFile?: boolean;
        react?: boolean;
    };
    /**
     * Optional streaming output guard. When `active(ctx)` is true, the assistant's reply is buffered and
     * each completed chunk is passed through `check` before being sent — redacting sensitive content in
     * place without ever sending-then-editing. Use it to scrub e.g. internal ids / pay / PII out of group
     * replies while leaving private (admin) chats untouched.
     */
    guard?: OutputGuard;
    /**
     * Server-owned conversation memory. `history.load` seeds the agent with prior turns before each
     * message; `history.save` persists the turn after the reply; `history.search` (optional) backs a
     * built-in `search_history` tool. Without it the bot is stateless (each message starts fresh).
     */
    history?: BotHistory;
};
/** Identity helper that types the default export of `src/bots/telegram/bot.ts`. */
declare function defineTelegramBot(config: TelegramBotConfig): TelegramBotConfig;

type RunAgentOptions = {
    prompt: string;
    tools: ToolSet;
    model: LanguageModel;
    systemPrompt?: string;
    maxSteps?: number;
};
type RunAgentResult = {
    text: string;
    steps: number;
};
declare function runAgent(options: RunAgentOptions): Promise<RunAgentResult>;
type StreamAgentOptions = {
    tools: ToolSet;
    model: LanguageModel;
    systemPrompt?: string;
    maxSteps?: number;
    /** Full conversation history (including the current user turn). Takes precedence over `prompt`. */
    messages?: ModelMessage[];
    /** Used only when `messages` is empty — a single user prompt. */
    prompt?: string;
    /** Called for each text chunk as the model streams its final answer. */
    onDelta?: (delta: string) => void;
    /** Called when the model invokes a tool — useful for a live `🔧 <name>` trail. */
    onToolCall?: (name: string) => void;
};
/**
 * Streaming counterpart to {@link runAgent}. Drives an agent loop with `streamText`, forwarding text
 * deltas (and optional tool-call events) through callbacks, and resolves to the final text + step count.
 * Run it inside `botContextStorage.run(ctx, () => runAgentStream(...))` so tool routes see the live
 * BotContext on `event.context` exactly like the Telegram transport.
 */
declare function runAgentStream(options: StreamAgentOptions): Promise<RunAgentResult>;

/** A single event from {@link runAgentEventStream}: a text chunk or a tool invocation. */
type AgentEvent = {
    type: "delta";
    text: string;
} | {
    type: "tool";
    name: string;
};
type AgentEventStreamOptions = {
    tools: ToolSet;
    model: LanguageModel;
    maxSteps?: number;
    systemPrompt?: string;
    /** Full conversation history including the current user turn. Takes precedence over `prompt`. */
    messages?: ModelMessage[];
    prompt?: string;
    /** Conversation id surfaced to tool routes as `event.context.bot.threadId`. */
    conversationId?: string;
    user?: {
        id: string;
        username?: string;
        firstName?: string;
        lastName?: string;
    };
    /** Extra fields merged onto `event.context` for tool routes (e.g. the resolved app user, draft id). */
    context?: NitroBotContext;
};
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
declare function runAgentEventStream(opts: AgentEventStreamOptions): AsyncGenerator<AgentEvent, RunAgentResult>;

declare const botContextStorage: AsyncLocalStorage<BotContext>;
/** Read the current BotContext inside any code reached by an agent invocation (tool routes, sub-handlers, etc.). */
declare function getBotContext(): BotContext | undefined;

declare const BOT_TOOL_BRAND: unique symbol;
/**
 * A tool that only makes sense inside a chat (it sends files, reacts, reads thread state) and so
 * isn't an HTTP route. Define these under `src/bots/<name>/tools/*.ts`; nitro-bot discovers them and
 * exposes them to that bot's agent alongside the route tools. `execute` receives the live
 * {@link BotContext}, including `ctx.reply.sendDocument(...)`.
 */
type BotToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
    readonly [BOT_TOOL_BRAND]: true;
    name: string;
    description: string;
    input: I;
    /** When true, the call is not surfaced in the reply's `🔧 <name>` trail (e.g. `react`). */
    hidden?: boolean;
    /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
    subagent?: string;
    execute: (input: z.infer<z.ZodObject<I>>, ctx: BotContext) => unknown | Promise<unknown>;
};
declare function botTool<I extends z.ZodRawShape = Record<string, never>>(def: {
    name: string;
    description: string;
    /** Use `.nullable()` (not `.optional()`) for optional fields — LLM tool schemas reject optional. */
    input?: I;
    /** When true, hide this tool's call from the reply's `🔧 <name>` trail (the model still calls it normally). */
    hidden?: boolean;
    /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
    subagent?: string;
    execute: (input: z.infer<z.ZodObject<I>>, ctx: BotContext) => unknown | Promise<unknown>;
}): BotToolDefinition<I>;
declare function isBotToolDefinition(value: unknown): value is BotToolDefinition;
/**
 * A bot tool with its input type erased so heterogeneous tools live in one array. `execute(input: never)`
 * makes every concrete `BotToolDefinition<I>` assignable here (contravariance).
 */
type AnyBotTool = {
    name: string;
    description: string;
    input: z.ZodRawShape;
    hidden?: boolean;
    subagent?: string;
    execute: (input: never, ctx: BotContext) => unknown | Promise<unknown>;
};
/** Convert bot-local tool definitions into an AI SDK ToolSet that pulls the live BotContext at call time. */
declare function buildBotToolSet(defs: readonly AnyBotTool[]): ToolSet;

type RequestSource = "query" | "json" | "form";
type ChatConfig = {
    /**
     * HTTP endpoint mounted on the Nitro app for the chat API. Set to `false` to NOT mount any chat
     * handler — useful when the consumer serves `/chat` itself (e.g. a `@elumixor/nitro-client`
     * async-generator route that delegates to `runAgentEventStream`, for a fully typed client). Tool
     * discovery, the `#nitro-bot` runtime (`toolRoutes`/`tools`/`chatConfig`), and bots are unaffected.
     */
    endpoint?: string | false;
    source?: RequestSource;
    field?: string;
    model?: LanguageModel;
    /**
     * Optional cheap model used only to turn each tool call into a short human-readable line in the live
     * `🔧` trail (e.g. "Looking up Yehor" instead of `🔧 find_person`). When unset, the bare tool name is
     * shown. Pass a gateway model id string (e.g. "google/gemini-3.5-flash").
     */
    labelModel?: LanguageModel;
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
type ResolvedChatConfig = Required<Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model" | "botsDir" | "stream">> & Pick<ChatConfig, "systemPrompt" | "sessionFile" | "labelModel">;
declare function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig;

declare const TOOL_BRAND: unique symbol;
type ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
    readonly [TOOL_BRAND]: true;
    name: string;
    description: string;
    input: I;
    /** When true, the call is not surfaced in the reply's `🔧 <name>` trail. */
    hidden?: boolean;
    /**
     * Assigns this tool to a subagent (see {@link defineSubagent}). The coordinator reaches it only by
     * delegating to that subagent. Omit to keep the tool shared — available to the coordinator and every
     * subagent. Ignored when the bot declares no subagents.
     */
    subagent?: string;
};
type ToolInput<T> = T extends ToolDefinition<infer I> ? I : never;
declare function tool<I extends z.ZodRawShape = Record<string, never>>(def: {
    name: string;
    description: string;
    input?: I;
    /** When true, hide this tool's call from the reply's `🔧 <name>` trail (the model still calls it normally). */
    hidden?: boolean;
    /** Assign this tool to a subagent group. Omit to keep it shared across the coordinator and all subagents. */
    subagent?: string;
}): ToolDefinition<I>;
declare function isToolDefinition(value: unknown): value is ToolDefinition;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type ToolRoute = {
    method: HttpMethod;
    path: string;
    module: {
        definition: ToolDefinition;
    };
    /** Auto-extracted body/query zod shape. Used only when the tool's own `definition.input` is empty. */
    autoInput?: z.ZodRawShape;
    /** Zod shape for the dynamic path segments (`[id]`). Always merged into the tool input, even when `definition.input` is set. */
    paramsInput?: z.ZodRawShape;
    /** Names of dynamic path segments (`[id]` → `"id"`). Pulled out of the tool input and routed to `event.context.params`. */
    params?: string[];
};
type InvokeFn = (route: ToolRoute, input: unknown) => unknown | Promise<unknown>;
type ChatOptions = {
    tools: ToolRoute[];
    model?: LanguageModel;
    systemPrompt?: string;
    maxSteps?: number;
    invoke?: InvokeFn;
    source?: RequestSource;
    field?: string;
};
type ChatResponse = {
    text: string;
    steps: number;
};
declare function buildToolSet(routes: ToolRoute[], invoke: InvokeFn): ToolSet;
declare function createChatHandler(options: ChatOptions): EventHandler<h3.EventHandlerRequest, Promise<ChatResponse>>;
declare function defaultInvoke(route: ToolRoute, input: unknown): Promise<unknown>;

type CommandContext = BotContext & {
    /** Text after the command, trimmed (e.g. "/pay 100 usd" → "100 usd"). */
    args: string;
    /** Invoke a route tool by name directly (bypasses the LLM). Returns its raw result. */
    invokeTool: (name: string, input?: unknown) => Promise<unknown>;
};
type BotCommandDef = {
    /** Command name without the leading slash. Optional — defaults to the file name (`me.ts` → "me"). */
    name?: string;
    /** Shown in Telegram's command menu and in /help. */
    description: string;
    /** Runs when the command is invoked — NOT routed through the agent. Return markdown to send. */
    run: (ctx: CommandContext) => string | Promise<string>;
};
/** Identity helper that types the default export of `src/bots/<name>/commands/*.ts`. */
declare function botCommand(def: BotCommandDef): BotCommandDef;

type BotEntry = {
    bot: Bot;
    /** Present only in webhook mode — feeds an incoming HTTP request to grammy. */
    handleUpdate?: (req: Request) => Promise<Response>;
};
declare function registerBot(name: string, entry: BotEntry): void;
/** Reach a running bot from anywhere (routes, webhooks, plugins). Omit `name` to get the first one. */
declare function getBot(name?: string): BotEntry | undefined;

/**
 * What `resolve()` returns for a single HTTP chat request: who the user is, which server-side
 * conversation this turn belongs to, the system prompt for this turn, and any extra context that
 * should be visible to tool routes on `event.context`.
 */
type ChatSessionResolved = {
    /** Stable id of the conversation this turn belongs to. History is loaded/saved against it. */
    conversationId: string;
    /** System prompt for this turn (built from app state — current draft, available templates, …). */
    systemPrompt?: string;
    /** Identity surfaced to the agent/tools. Maps onto `BotContext.user`. */
    user?: {
        id: string;
        username?: string;
        firstName?: string;
        lastName?: string;
    };
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
type ChatSessionDef = {
    /**
     * Authenticate the request and resolve the conversation. Receives the live h3 event (cookies, headers)
     * and the raw request body. Throw an h3 error (e.g. `createError({ statusCode: 401 })`) to reject.
     */
    resolve: (event: H3Event, body: Record<string, unknown>) => Promise<ChatSessionResolved> | ChatSessionResolved;
    /** Load prior messages for the conversation (oldest → newest). Omit for a stateless single-turn chat. */
    loadHistory?: (resolved: ChatSessionResolved, event: H3Event) => Promise<ModelMessage[]> | ModelMessage[];
    /** Persist the completed turn so the next request has context. Errors are logged, not surfaced. */
    save?: (resolved: ChatSessionResolved, turn: {
        user: string;
        assistant: string;
    }, event: H3Event) => Promise<void> | void;
};
/** Identity helper that types the default export of the session file. */
declare function defineChatSession(def: ChatSessionDef): ChatSessionDef;

type SessionChatOptions = {
    session: ChatSessionDef;
    tools: ToolRoute[];
    model: LanguageModel;
    maxSteps: number;
    /** Body field carrying the user message (default `message`). */
    field?: string;
    /** Stream the reply as Server-Sent Events. When false, returns `{ text, steps }` once finished. */
    stream?: boolean;
};
/**
 * HTTP `/chat` handler backed by server-side sessions (see {@link defineChatSession}). Resolves the
 * request to a conversation, loads its history, runs a streaming agent loop with the route tools, and
 * persists the turn. The agent runs inside `botContextStorage` so tool routes read `event.context`
 * (user, conversation, app-specific fields) just like the Telegram transport.
 */
declare function createSessionChatHandler(options: SessionChatOptions): h3.EventHandler<h3.EventHandlerRequest, Promise<ReadableStream<Uint8Array<ArrayBufferLike>> | {
    text: string;
    steps: number;
}>>;

declare const SUBAGENT_BRAND: unique symbol;
/**
 * A focused agent that owns a subset of the bot's tools. The coordinator (the bot's top-level agent)
 * sees one `delegate_to_<name>` tool per subagent — its `description` is the routing signal — and hands
 * a self-contained task to it. The subagent then runs its own agent loop over only its tools (plus the
 * shared, untagged tools), keeping the coordinator's tool surface small.
 *
 * Declare these under `src/bots/<name>/subagents/*.ts`; the file name is the default `name`
 * (`subagents/time.ts` → "time"), overridable by setting `name` explicitly. Tag a route/bot tool into a
 * subagent with `subagent: "<name>"` on its `tool({...})` / `botTool({...})` definition.
 */
type SubagentDefinition = {
    readonly [SUBAGENT_BRAND]: true;
    /** Group key. Tools tagged `subagent: "<name>"` belong to this subagent. Defaults to the file name. */
    name: string;
    /** Shown to the coordinator as the `delegate_to_<name>` tool description — make it a clear routing signal. */
    description: string;
    /** System prompt for the subagent's own loop. Falls back to a generic instruction when omitted. */
    systemPrompt?: string;
    /** Gateway model id override (defaults to the bot's model). */
    model?: string;
    /** Max agent steps for the subagent's own loop (defaults to the bot's maxSteps). */
    maxSteps?: number;
};
declare function defineSubagent(def: {
    name?: string;
    description: string;
    systemPrompt?: string;
    model?: string;
    maxSteps?: number;
}): SubagentDefinition;
declare function isSubagentDefinition(value: unknown): value is SubagentDefinition;

export { getBotContext as $, botCommand as G, botContextStorage as J, botPost as K, botPre as L, botTool as M, buildBotToolSet as P, buildToolSet as Q, createChatHandler as U, createSessionChatHandler as V, defaultInvoke as W, defineChatSession as X, defineSubagent as Y, defineTelegramBot as Z, getBot as _, isBotToolDefinition as a0, isSubagentDefinition as a1, isToolDefinition as a2, makeToolLabeler as a3, registerBot as a4, resolveChatConfig as a5, runAgent as a6, runAgentEventStream as a7, runAgentStream as a8, tool as a9 };
export type { AgentEvent as A, BotAttachment as B, ChatConfig as C, ToolInput as D, ToolLabeler as E, ToolRoute as F, HistoryMessage as H, InvokeFn as I, NitroBotContext as N, OutputGuard as O, RequestSource as R, SessionChatOptions as S, TelegramBotConfig as T, AgentEventStreamOptions as a, AnyBotTool as b, BotCommandDef as c, BotContext as d, BotEntry as e, BotHistory as f, BotPostFn as g, BotPreFn as h, BotToolDefinition as i, ChatOptions as j, ChatReply as k, ChatResponse as l, ChatSessionDef as m, ChatSessionResolved as n, CommandContext as o, HttpMethod as p, OutputGuardInput as q, ResolvedChatConfig as r, RunAgentOptions as s, RunAgentResult as t, StreamAgentOptions as u, SubagentDefinition as v, TelegramBotInfo as w, TelegramWebhookConfig as x, ToolCallInfo as y, ToolDefinition as z };
