import { e as BotToolDefinition, H as HttpMethod, C as ChatConfig } from './shared/nitro-bot.B7RkE1jc.js';
export { A as AnyBotTool, B as BotCommandDef, a as BotContext, b as BotEntry, c as BotPostFn, d as BotPreFn, f as ChatOptions, g as ChatReply, h as ChatResponse, i as CommandContext, I as InvokeFn, N as NitroBotContext, R as RequestSource, j as ResolvedChatConfig, S as SubagentDefinition, T as TelegramBotConfig, k as TelegramBotInfo, l as TelegramWebhookConfig, m as ToolDefinition, n as ToolInput, o as ToolRoute, p as botCommand, r as botPost, s as botPre, t as botTool, u as buildBotToolSet, v as buildToolSet, w as createChatHandler, x as defaultInvoke, y as defineSubagent, z as defineTelegramBot, D as getBot, E as getBotContext, F as isBotToolDefinition, G as isSubagentDefinition, J as isToolDefinition, K as registerBot, L as resolveChatConfig, M as tool } from './shared/nitro-bot.B7RkE1jc.js';
import { ToolSet, LanguageModel } from 'ai';
import { z } from 'zod';
import 'grammy';
import 'node:async_hooks';
import 'h3';

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

export { BotToolDefinition, ChatConfig, HttpMethod, discoverToolRoutes, nitroBotModule, runAgent, sendFileBuiltin };
export type { DiscoveredRoute, NitroBotModuleOptions, RunAgentOptions, RunAgentResult };
