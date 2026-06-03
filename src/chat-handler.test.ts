import { describe, expect, test } from "bun:test";
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content } from "@ai-sdk/provider";
import { asSchema, generateText, type LanguageModel, stepCountIs } from "ai";
import { createApp, toWebHandler } from "h3";
import { z } from "zod";
import { buildToolSet, createChatHandler, defaultInvoke, type ToolRoute } from "./chat-handler";
import { tool } from "./tool";

const weatherRoute: ToolRoute = {
  method: "GET",
  path: "/weather",
  module: {
    definition: tool({
      name: "get_weather",
      description: "Get the weather for a city.",
      input: { city: z.string() },
    }),
  },
};

type StepResponse = { content: LanguageModelV2Content[]; finishReason: "tool-calls" | "stop" };

function scriptedModel(steps: StepResponse[]): LanguageModel & { calls: LanguageModelV2CallOptions[] } {
  let index = 0;
  const calls: LanguageModelV2CallOptions[] = [];
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate(options: LanguageModelV2CallOptions) {
      calls.push(options);
      const step = steps[index++];
      if (!step) return Promise.reject(new Error(`scriptedModel: no scripted response for call #${index}`));
      return Promise.resolve({
        content: step.content,
        finishReason: step.finishReason,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      });
    },
    doStream() {
      return Promise.reject(new Error("scriptedModel: doStream not implemented"));
    },
  };
  return Object.assign(model, { calls });
}

describe("LLM-safe schema rewriting", () => {
  test("optional fields are exposed as nullable on the tool's input schema", () => {
    const route: ToolRoute = {
      method: "POST",
      path: "/x",
      module: {
        definition: tool({
          name: "x",
          description: "x",
          input: { required: z.string(), maybe: z.string().optional() },
        }),
      },
    };
    const tools = buildToolSet([route], () => ({ ok: true }));
    const schema = tools.x?.inputSchema as z.ZodObject<z.ZodRawShape>;

    expect(schema.parse({ required: "ok", maybe: null })).toEqual({ required: "ok", maybe: null });
    expect(schema.parse({ required: "ok", maybe: "hi" })).toEqual({ required: "ok", maybe: "hi" });
    expect(() => schema.parse({ required: "ok" })).toThrow();
  });

  test("date fields (incl. coerced and nested) become JSON-representable strings but still parse to Date", () => {
    const route: ToolRoute = {
      method: "POST",
      path: "/x",
      module: {
        definition: tool({
          name: "x",
          description: "x",
          input: {
            date: z.coerce.date().describe("The day."),
            rawDate: z.date(),
            maybeDate: z.coerce.date().optional(),
            milestones: z.array(z.object({ startDate: z.coerce.date() })),
          },
        }),
      },
    };
    const tools = buildToolSet([route], () => ({ ok: true }));
    const schema = tools.x?.inputSchema as z.ZodType;

    // Representable: converting to JSON Schema must not throw, and dates surface as strings.
    const json = asSchema(schema).jsonSchema as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(json.properties.date).toMatchObject({ type: "string", description: "The day." });
    expect(json.properties.rawDate).toMatchObject({ type: "string" });
    expect(json.properties.milestones).toMatchObject({ type: "array" });

    // Parsing still yields real Date objects, including nested ones.
    const parsed = (schema as z.ZodType).parse({
      date: "2026-06-03",
      rawDate: "2026-02-02",
      maybeDate: null,
      milestones: [{ startDate: "2026-01-01" }],
    }) as { date: Date; rawDate: Date; milestones: { startDate: Date }[] };
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.rawDate).toBeInstanceOf(Date);
    expect(parsed.milestones[0]?.startDate).toBeInstanceOf(Date);

    // Invalid date strings are still rejected.
    expect(() => (schema as z.ZodType).parse({ date: "nope", rawDate: "2026-02-02", milestones: [] })).toThrow();
  });

  test("a genuinely unrepresentable input type fails at build time, naming the tool", () => {
    const route: ToolRoute = {
      method: "POST",
      path: "/x",
      module: { definition: tool({ name: "bad_tool", description: "x", input: { m: z.map(z.string(), z.string()) } }) },
    };
    expect(() => buildToolSet([route], () => ({ ok: true }))).toThrow(/bad_tool/);
  });
});

describe("paramsInput merging into the tool schema", () => {
  const paramsInput = { id: z.string().describe('Selects a single record from "people".') };

  test("merges params on top of auto-extracted body/query input", () => {
    const route: ToolRoute = {
      method: "PATCH",
      path: "/people/:id",
      paramsInput,
      params: ["id"],
      autoInput: { name: z.string() },
      module: { definition: tool({ name: "update_person", description: "x" }) },
    };
    const tools = buildToolSet([route], () => ({ ok: true }));
    const schema = tools.update_person?.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(schema.shape).sort()).toEqual(["id", "name"]);
  });

  test("merges params even when the tool defines its own explicit input", () => {
    const route: ToolRoute = {
      method: "PATCH",
      path: "/people/:id",
      paramsInput,
      params: ["id"],
      module: { definition: tool({ name: "update_person", description: "x", input: { email: z.string() } }) },
    };
    const tools = buildToolSet([route], () => ({ ok: true }));
    const schema = tools.update_person?.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(schema.shape).sort()).toEqual(["email", "id"]);
  });
});

describe("defaultInvoke route-param routing", () => {
  function routeWith(method: ToolRoute["method"], params: string[], handlerFn: (event: unknown) => unknown): ToolRoute {
    return {
      method,
      path: "/people/:id/notes/:noteId",
      params,
      module: { definition: tool({ name: "t", description: "t" }), default: handlerFn } as never,
    };
  }

  test("PATCH: params go to event.context.params, the rest becomes the body", async () => {
    let seen: { params: unknown; body: unknown } | undefined;
    const route = routeWith("PATCH", ["id", "noteId"], (event) => {
      const e = event as { context: { params?: unknown }; _requestBody?: unknown };
      seen = { params: e.context.params, body: e._requestBody };
      return { ok: true };
    });

    await defaultInvoke(route, { id: "p1", noteId: "n2", text: "hello" });

    expect(seen?.params).toEqual({ id: "p1", noteId: "n2" });
    expect(seen?.body).toEqual({ text: "hello" });
  });

  test("DELETE: a param-only input leaves an empty query and still sets params", async () => {
    let seen: { params: unknown; path: unknown } | undefined;
    const route = routeWith("DELETE", ["id"], (event) => {
      const e = event as { context: { params?: unknown }; path?: unknown };
      seen = { params: e.context.params, path: e.path };
      return { ok: true };
    });

    await defaultInvoke(route, { id: "p1" });

    expect(seen?.params).toEqual({ id: "p1" });
    expect(seen?.path).toBe("/");
  });

  test("numeric/coerced param values are stringified for the router", async () => {
    let seen: unknown;
    const route = routeWith("DELETE", ["id"], (event) => {
      seen = (event as { context: { params?: unknown } }).context.params;
      return { ok: true };
    });

    await defaultInvoke(route, { id: 42 });

    expect(seen).toEqual({ id: "42" });
  });
});

describe("agent loop with a scripted model", () => {
  test("calls the tool's invoke with the parsed input, then summarises the result", async () => {
    const calls: Array<{ route: ToolRoute; input: unknown }> = [];
    const tools = buildToolSet([weatherRoute], (route, input) => {
      calls.push({ route, input });
      return { city: (input as { city: string }).city, tempCelsius: 21 };
    });

    const model = scriptedModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Berlin" }),
          },
        ],
        finishReason: "tool-calls",
      },
      {
        content: [{ type: "text", text: "It is 21°C in Berlin." }],
        finishReason: "stop",
      },
    ]);

    const result = await generateText({
      model,
      prompt: "weather in Berlin?",
      tools,
      stopWhen: stepCountIs(4),
    });

    expect(result.text).toBe("It is 21°C in Berlin.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route.path).toBe("/weather");
    expect(calls[0]?.input).toEqual({ city: "Berlin" });

    expect(model.calls).toHaveLength(2);
    const secondCallPrompt = JSON.stringify(model.calls[1]?.prompt);
    expect(secondCallPrompt).toContain("tempCelsius");
    expect(secondCallPrompt).toContain("21");
  });
});

describe("createChatHandler end-to-end", () => {
  test("dispatches the chat request and returns the model's final text", async () => {
    const calls: Array<{ route: ToolRoute; input: unknown }> = [];

    const model = scriptedModel([
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Berlin" }),
          },
        ],
        finishReason: "tool-calls",
      },
      { content: [{ type: "text", text: "Berlin is 21°C." }], finishReason: "stop" },
    ]);

    const handler = createChatHandler({
      tools: [weatherRoute],
      model,
      invoke: (route, input) => {
        calls.push({ route, input });
        return { city: (input as { city: string }).city, tempCelsius: 21 };
      },
    });

    const app = createApp();
    app.use("/chat", handler);
    const fetchHandler = toWebHandler(app);

    const response = await fetchHandler(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "weather in Berlin" }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { text: string; steps: number };
    expect(payload.text).toBe("Berlin is 21°C.");
    expect(payload.steps).toBe(2);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.route.path).toBe("/weather");
    expect(calls[0]?.input).toEqual({ city: "Berlin" });
  });

  test("reads the prompt from the query string when source is 'query'", async () => {
    const model = scriptedModel([{ content: [{ type: "text", text: "ok" }], finishReason: "stop" }]);
    const handler = createChatHandler({
      tools: [weatherRoute],
      model,
      source: "query",
      field: "q",
      invoke: () => ({ unused: true }),
    });

    const app = createApp();
    app.use("/chat", handler);
    const fetchHandler = toWebHandler(app);

    const response = await fetchHandler(new Request("http://localhost/chat?q=hello%20there", { method: "GET" }));

    expect(response.status).toBe(200);
    const promptArg = (model.calls[0]?.prompt as Array<{ content: Array<{ text?: string }> }>)?.[0]?.content?.[0]?.text;
    expect(promptArg).toBe("hello there");
  });

  test("reads the prompt from multipart form data when source is 'form'", async () => {
    const model = scriptedModel([{ content: [{ type: "text", text: "ok" }], finishReason: "stop" }]);
    const handler = createChatHandler({
      tools: [weatherRoute],
      model,
      source: "form",
      field: "prompt",
      invoke: () => ({ unused: true }),
    });

    const app = createApp();
    app.use("/chat", handler);
    const fetchHandler = toWebHandler(app);

    const form = new FormData();
    form.append("prompt", "from a form");
    const response = await fetchHandler(new Request("http://localhost/chat", { method: "POST", body: form }));

    expect(response.status).toBe(200);
    const promptArg = (model.calls[0]?.prompt as Array<{ content: Array<{ text?: string }> }>)?.[0]?.content?.[0]?.text;
    expect(promptArg).toBe("from a form");
  });

  test("rejects requests missing the configured prompt field", async () => {
    const handler = createChatHandler({
      tools: [weatherRoute],
      model: scriptedModel([]),
      invoke: () => ({ unused: true }),
    });

    const app = createApp();
    app.use("/chat", handler);
    const fetchHandler = toWebHandler(app);

    const response = await fetchHandler(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "wrong field" }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
