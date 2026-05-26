import { tool as aiTool, generateText, type LanguageModel, stepCountIs, type ToolSet } from "ai";
import { defineEventHandler, getValidatedQuery, readFormData, readValidatedBody } from "h3";
import { z } from "zod";
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
        inputSchema: z.object(inputShape),
        execute: async (input: unknown) => invoke(route, input),
      }),
    ] as const;
  });
  return Object.fromEntries(entries) as ToolSet;
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
    const result = await generateText({
      model,
      system,
      prompt,
      tools,
      stopWhen: stepCountIs(maxSteps),
    });
    const response: ChatResponse = { text: result.text, steps: result.steps?.length ?? 0 };
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

function defaultInvoke(route: ToolRoute, input: unknown): Promise<unknown> {
  const fetcher = (globalThis as { $fetch?: NitroFetch }).$fetch;
  if (!fetcher)
    return Promise.reject(new Error("Global $fetch unavailable. Pass a custom `invoke` to createChatHandler."));
  const useQuery = route.method === "GET" || route.method === "DELETE";
  return fetcher(route.path, {
    method: route.method,
    ...(useQuery ? { query: input } : { body: input }),
  });
}
