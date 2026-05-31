import { tool as aiTool, type LanguageModel, type ToolSet } from "ai";
import { defineEventHandler, type EventHandler, type H3Event, getValidatedQuery, readFormData, readValidatedBody } from "h3";
import { z } from "zod";
import { runAgent } from "./agent";
import { getBotContext } from "./als";
import type { RequestSource } from "./config";
import type { ToolDefinition } from "./tool";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type ToolRoute = {
  method: HttpMethod;
  path: string;
  module: { definition: ToolDefinition };
  autoInput?: z.ZodRawShape;
};

export type InvokeFn = (route: ToolRoute, input: unknown) => unknown | Promise<unknown>;

export type ChatOptions = {
  tools: ToolRoute[];
  model?: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
  invoke?: InvokeFn;
  source?: RequestSource;
  field?: string;
};

export type ChatResponse = {
  text: string;
  steps: number;
};

export function buildToolSet(routes: ToolRoute[], invoke: InvokeFn): ToolSet {
  const entries = routes.map((route) => {
    const { definition } = route.module;
    const inputShape =
      Object.keys(definition.input).length > 0 ? definition.input : (route.autoInput ?? definition.input);
    return [
      definition.name,
      aiTool({
        description: definition.description,
        inputSchema: z.object(llmSafeShape(inputShape)),
        execute: async (input: unknown) => invoke(route, input),
      }),
    ] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
}

function llmSafeShape(shape: z.ZodRawShape): z.ZodRawShape {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = toNullableIfOptional(schema as z.ZodType);
  return out;
}

function toNullableIfOptional(schema: z.ZodType): z.ZodType {
  type V4Internal = { _zod?: { def?: { type?: string; innerType?: z.ZodType } } };
  const internal = schema as unknown as V4Internal;
  if (internal._zod?.def?.type !== "optional") return schema;
  const inner = internal._zod.def.innerType;
  return inner ? inner.nullable() : schema;
}

export function createChatHandler(options: ChatOptions) {
  const invoke = options.invoke ?? defaultInvoke;
  const model: LanguageModel = options.model ?? "anthropic/claude-sonnet-4.6";
  const maxSteps = options.maxSteps ?? 8;
  const system = options.systemPrompt;
  const source: RequestSource = options.source ?? "json";
  const field = options.field ?? "message";
  const tools = buildToolSet(options.tools, invoke);

  return defineEventHandler(async (event) => {
    const prompt = await readPrompt(event, source, field);
    const result = await runAgent({ prompt, tools, model, systemPrompt: system, maxSteps });
    const response: ChatResponse = { text: result.text, steps: result.steps };
    return response;
  });
}

async function readPrompt(
  event: Parameters<Parameters<typeof defineEventHandler>[0]>[0],
  source: RequestSource,
  field: string,
): Promise<string> {
  if (source === "query") {
    const schema = z.object({ [field]: z.string() });
    const data = await getValidatedQuery(event, (raw) => schema.parse(raw));
    return data[field] as string;
  }
  if (source === "form") {
    const form = await readFormData(event);
    const value = form.get(field);
    if (typeof value !== "string" || value.length === 0)
      throw Object.assign(new Error(`Form field '${field}' is required.`), { statusCode: 400 });
    return value;
  }
  const schema = z.object({ [field]: z.string() });
  const data = await readValidatedBody(event, (raw) => schema.parse(raw));
  return data[field] as string;
}

type NitroFetch = (path: string, opts: { method: HttpMethod; query?: unknown; body?: unknown }) => Promise<unknown>;

type ExecutableHandler = EventHandler & {
  execute?: (event: H3Event, body?: unknown, query?: unknown) => Promise<unknown>;
};

export async function defaultInvoke(route: ToolRoute, input: unknown): Promise<unknown> {
  const handler = (route.module as { default?: ExecutableHandler }).default;
  const useQuery = route.method === "GET" || route.method === "DELETE";

  if (handler && typeof handler.execute === "function") {
    // Direct in-process invocation — no HTTP/h3 middleware, no body re-parsing.
    const event = createSyntheticEvent();
    return await handler.execute(event, useQuery ? undefined : input, useQuery ? input : undefined);
  }

  // Fallback: routes not built with `@elumixor/nitro-client`'s `handler()` still work via $fetch.
  const fetcher = (globalThis as { $fetch?: NitroFetch }).$fetch;
  if (!fetcher) {
    throw new Error(
      `[nitro-bot] route ${route.path} has no .execute (not built with nitro-client's handler()) and \`$fetch\` is unavailable. Pass a custom \`invoke\` to createChatHandler.`,
    );
  }
  return fetcher(route.path, {
    method: route.method,
    ...(useQuery ? { query: input } : { body: input }),
  });
}

/**
 * Minimal h3-compatible event for in-process tool invocation. Populates `event.context` from
 * the active BotContext (set via `botContextStorage.run(...)` in the bot runtime) so route
 * handlers see `event.context.bot.threadId / userId / ...` exactly like on real HTTP.
 */
function createSyntheticEvent(): H3Event {
  const noop = () => {};
  const ctx = getBotContext();
  const baseContext: Record<string, unknown> = {};
  if (ctx) {
    baseContext.bot = {
      threadId: ctx.thread.id,
      threadName: ctx.thread.title,
      threadType: ctx.thread.type,
      userId: ctx.user.id,
      userName: ctx.user.username ?? ctx.user.firstName,
      botName: ctx.bot.name,
      botUsername: ctx.bot.username,
      messageId: ctx.message.id,
      replyToId: ctx.message.replyToId,
    };
    Object.assign(baseContext, ctx.context);
  }
  const req = { headers: {}, method: "POST", url: "/", on: noop };
  const res = { on: noop, once: noop, end: noop, setHeader: noop, getHeader: () => undefined, statusCode: 200, headersSent: false };
  return {
    node: { req, res },
    context: baseContext,
    path: "/",
    method: "POST",
    headers: new Headers(),
    web: { request: new Request("http://localhost/") },
  } as unknown as H3Event;
}
