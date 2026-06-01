import { e as BotToolDefinition } from './shared/nitro-bot.CrIQ3eEt.mjs';
export { A as AnyBotTool, B as BotCommandDef, a as BotContext, b as BotEntry, c as BotPostFn, d as BotPreFn, C as ChatReply, f as CommandContext, N as NitroBotContext, T as TelegramBotConfig, g as TelegramBotInfo, h as TelegramWebhookConfig, i as botCommand, k as botPost, l as botPre, m as botTool, n as buildBotToolSet, o as defineTelegramBot, p as getBot, q as getBotContext, r as isBotToolDefinition, s as registerBot } from './shared/nitro-bot.CrIQ3eEt.mjs';
import { ToolSet, LanguageModel } from 'ai';
import { z } from 'zod';
import * as h3 from 'h3';
import { EventHandler } from 'h3';
import 'grammy';
import 'node:async_hooks';

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

type RequestSource = "query" | "json" | "form";
type ChatConfig = {
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
};
type ResolvedChatConfig = Required<Pick<ChatConfig, "endpoint" | "source" | "field" | "maxSteps" | "model" | "botsDir">> & Pick<ChatConfig, "systemPrompt">;
declare function resolveChatConfig(config: ChatConfig | undefined): ResolvedChatConfig;

declare const TOOL_BRAND: unique symbol;
type ToolDefinition<I extends z.ZodRawShape = z.ZodRawShape> = {
    readonly [TOOL_BRAND]: true;
    name: string;
    description: string;
    input: I;
};
type ToolInput<T> = T extends ToolDefinition<infer I> ? I : never;
declare function tool<I extends z.ZodRawShape = Record<string, never>>(def: {
    name: string;
    description: string;
    input?: I;
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

type ExtractedSchema = {
    bodyText?: string;
    queryText?: string;
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

export { BotToolDefinition, buildToolSet, createChatHandler, defaultInvoke, discoverToolRoutes, isToolDefinition, nitroBotModule, resolveChatConfig, runAgent, sendFileBuiltin, tool };
export type { ChatConfig, ChatOptions, ChatResponse, DiscoveredRoute, HttpMethod, InvokeFn, NitroBotModuleOptions, RequestSource, ResolvedChatConfig, RunAgentOptions, RunAgentResult, ToolDefinition, ToolInput, ToolRoute };
