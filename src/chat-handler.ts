import { tool as aiTool, type LanguageModel, type ToolSet } from "ai";
import {
  defineEventHandler,
  type EventHandler,
  getValidatedQuery,
  type H3Event,
  readFormData,
  readValidatedBody,
} from "h3";
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
    // Legacy fast-path: older nitro-client builds attach `.execute`, which takes pre-parsed body/query.
    const event = createSyntheticEvent(route.method);
    return await handler.execute(event, useQuery ? undefined : input, useQuery ? input : undefined);
  }

  if (handler) {
    // Current nitro-client returns a plain h3 EventHandler (no `.execute`). Invoke it directly,
    // in-process, on a synthetic event that (a) carries the live BotContext — so `event.context.user`
    // and friends are populated from the same AsyncLocalStorage the renderer runs in — and (b) encodes
    // the tool input as the request body/query so the handler's own readValidatedBody/getValidatedQuery
    // recover it. We deliberately avoid `$fetch`: Nitro's internal fetch dispatches the route in a fresh
    // async context that does NOT carry our ALS store, so `getBotContext()` in the bot-context middleware
    // returned undefined and `event.context.user` silently came through empty.
    const event = createSyntheticEvent(route.method, useQuery ? { query: input } : { body: input });
    return await (handler as EventHandler)(event);
  }

  // Last resort: routes not built with `@elumixor/nitro-client`'s `handler()` at all — go over $fetch.
  const fetcher = (globalThis as { $fetch?: NitroFetch }).$fetch;
  if (!fetcher) {
    throw new Error(
      `[nitro-bot] route ${route.path} has no default handler and \`$fetch\` is unavailable. Pass a custom \`invoke\` to createChatHandler.`,
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
function encodeQuery(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

function createSyntheticEvent(method: HttpMethod = "POST", payload?: { body?: unknown; query?: unknown }): H3Event {
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

  // Encode the tool input so the route's own h3 body/query readers recover it (see defaultInvoke).
  const path = `/${encodeQuery(payload?.query)}`;
  const hasBody = !!payload && "body" in payload && payload.body !== undefined;
  const headers: Record<string, string> = hasBody ? { "content-type": "application/json" } : {};

  const req = { headers, method, url: path, on: noop };
  const res = {
    on: noop,
    once: noop,
    end: noop,
    setHeader: noop,
    getHeader: () => undefined,
    statusCode: 200,
    headersSent: false,
  };
  return {
    node: { req, res },
    context: baseContext,
    path,
    _path: path,
    // readRawBody() consumes `_requestBody` first; a plain object is JSON-stringified by h3.
    _requestBody: hasBody ? payload?.body : undefined,
    method,
    headers: new Headers(headers),
    web: { request: new Request(`http://localhost${path}`) },
  } as unknown as H3Event;
}
