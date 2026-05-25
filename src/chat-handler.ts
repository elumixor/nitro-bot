import { tool as aiTool, generateText, type LanguageModel, stepCountIs, type ToolSet } from "ai";
import { defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import type { ToolDefinition } from "./tool";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type ToolRoute = {
  method: HttpMethod;
  path: string;
  module: { definition: ToolDefinition };
};

export type InvokeFn = (route: ToolRoute, input: unknown) => unknown | Promise<unknown>;

export type ChatOptions = {
  tools: ToolRoute[];
  model?: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
  invoke?: InvokeFn;
};

export type ChatResponse = {
  text: string;
  steps: number;
};

export function buildToolSet(routes: ToolRoute[], invoke: InvokeFn): ToolSet {
  const entries = routes.map((route) => {
    const { definition } = route.module;
    return [
      definition.name,
      aiTool({
        description: definition.description,
        inputSchema: z.object(definition.input),
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
  const tools = buildToolSet(options.tools, invoke);

  return defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, (data) => z.object({ message: z.string() }).parse(data));
    const result = await generateText({
      model,
      system,
      prompt: body.message,
      tools,
      stopWhen: stepCountIs(maxSteps),
    });
    const response: ChatResponse = { text: result.text, steps: result.steps?.length ?? 0 };
    return response;
  });
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
