import { Bot } from 'grammy';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';

type TelegramWebhookConfig = {
    /** Public URL Telegram should POST updates to. Must resolve to this app's `/<botName>/webhook` route. */
    url: string;
    /** Optional secret token; validated by grammy's webhook callback. */
    secret?: string;
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
};
/** Identity helper that types the default export of `src/bots/telegram/bot.ts`. */
declare function defineTelegramBot(config: TelegramBotConfig): TelegramBotConfig;

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
        /** Sender id of the replied-to message, if this message is a reply. */
        replyToFromId?: string;
        /** True when this message replies directly to one of the bot's own messages. */
        repliesToBot?: boolean;
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
    execute: (input: z.infer<z.ZodObject<I>>, ctx: BotContext) => unknown | Promise<unknown>;
};
declare function botTool<I extends z.ZodRawShape = Record<string, never>>(def: {
    name: string;
    description: string;
    /** Use `.nullable()` (not `.optional()`) for optional fields — LLM tool schemas reject optional. */
    input?: I;
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
    execute: (input: never, ctx: BotContext) => unknown | Promise<unknown>;
};
/** Convert bot-local tool definitions into an AI SDK ToolSet that pulls the live BotContext at call time. */
declare function buildBotToolSet(defs: readonly AnyBotTool[]): ToolSet;

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

export { botCommand as i, botContextStorage as j, botPost as k, botPre as l, botTool as m, buildBotToolSet as n, defineTelegramBot as o, getBot as p, getBotContext as q, isBotToolDefinition as r, registerBot as s };
export type { AnyBotTool as A, BotCommandDef as B, ChatReply as C, NitroBotContext as N, TelegramBotConfig as T, BotContext as a, BotEntry as b, BotPostFn as c, BotPreFn as d, BotToolDefinition as e, CommandContext as f, TelegramBotInfo as g, TelegramWebhookConfig as h };
