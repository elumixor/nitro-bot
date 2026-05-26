import { describe, expect, test } from "bun:test";
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content } from "@ai-sdk/provider";
import { generateText, type LanguageModel, stepCountIs } from "ai";
import { createApp, toWebHandler } from "h3";
import { z } from "zod";
import { buildToolSet, createChatHandler, type ToolRoute } from "./chat-handler";
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
