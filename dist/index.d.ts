import { g as BotToolDefinition, H as HttpMethod, C as ChatConfig } from './shared/nitro-bot.CN3VpdzP.js';
export { A as AgentEvent, a as AgentEventStreamOptions, b as AnyBotTool, B as BotCommandDef, c as BotContext, d as BotEntry, e as BotPostFn, f as BotPreFn, h as ChatOptions, i as ChatReply, j as ChatResponse, k as ChatSessionDef, l as ChatSessionResolved, m as CommandContext, I as InvokeFn, N as NitroBotContext, R as RequestSource, n as ResolvedChatConfig, o as RunAgentOptions, p as RunAgentResult, S as SessionChatOptions, q as StreamAgentOptions, r as SubagentDefinition, T as TelegramBotConfig, s as TelegramBotInfo, t as TelegramWebhookConfig, u as ToolDefinition, v as ToolInput, w as ToolRoute, x as botCommand, z as botPost, D as botPre, E as botTool, F as buildBotToolSet, G as buildToolSet, J as createChatHandler, K as createSessionChatHandler, L as defaultInvoke, M as defineChatSession, O as defineSubagent, P as defineTelegramBot, Q as getBot, U as getBotContext, V as isBotToolDefinition, W as isSubagentDefinition, X as isToolDefinition, Y as registerBot, Z as resolveChatConfig, _ as runAgent, $ as runAgentEventStream, a0 as runAgentStream, a1 as tool } from './shared/nitro-bot.CN3VpdzP.js';
import { z } from 'zod';
import 'grammy';
import 'ai';
import 'node:async_hooks';
import 'h3';

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

export { BotToolDefinition, ChatConfig, HttpMethod, discoverToolRoutes, nitroBotModule, sendFileBuiltin };
export type { DiscoveredRoute, NitroBotModuleOptions };
