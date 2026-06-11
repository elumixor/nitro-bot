import { describe, expect, test } from "bun:test";
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { LanguageModel, ModelMessage } from "ai";
import type { H3Event } from "h3";
import type { ChatSessionDef } from "./session";
import { runAgentSession } from "./session-stream";

/** A streaming model that emits the given text as deltas, then stops. No tool calls. */
function streamingModel(text: string): LanguageModel {
  const parts: LanguageModelV2StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "streaming",
    supportedUrls: {},
    doGenerate() {
      return Promise.reject(new Error("doGenerate not implemented"));
    },
    doStream() {
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
  return model;
}

const fakeEvent = { context: {}, node: { req: {}, res: {} } } as unknown as H3Event;

describe("runAgentSession", () => {
  test("resolves the session, streams deltas, and persists the turn", async () => {
    const calls: string[] = [];
    let saved: { user: string; assistant: string } | undefined;

    const session: ChatSessionDef = {
      resolve: (_event, body) => {
        calls.push("resolve");
        // The full body is forwarded verbatim — the app reads its own fields (e.g. threadId) off it.
        expect(body).toEqual({ message: "hello", threadId: "t1" });
        return { conversationId: "t1", systemPrompt: "be brief", user: { id: "u1" }, context: { threadId: "t1" } };
      },
      loadHistory: () => {
        calls.push("loadHistory");
        return [{ role: "assistant", content: "earlier" }] as ModelMessage[];
      },
      save: (_resolved, turn) => {
        calls.push("save");
        saved = turn;
      },
    };

    const events: string[] = [];
    const gen = runAgentSession({
      session,
      event: fakeEvent,
      message: "hello",
      body: { message: "hello", threadId: "t1" },
      toolRoutes: [],
      model: streamingModel("hi there"),
    });

    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "delta") events.push(next.value.text);
      next = await gen.next();
    }

    expect(calls).toEqual(["resolve", "loadHistory", "save"]);
    expect(events.join("")).toBe("hi there");
    expect(saved).toEqual({ user: "hello", assistant: "hi there" });
    expect(next.value).toEqual({ steps: 1 });
  });

  test("works with no loadHistory/save (stateless)", async () => {
    const session: ChatSessionDef = {
      resolve: () => ({ conversationId: "x" }),
    };

    const gen = runAgentSession({
      session,
      event: fakeEvent,
      message: "ping",
      toolRoutes: [],
      model: streamingModel("pong"),
    });

    let text = "";
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "delta") text += next.value.text;
      next = await gen.next();
    }
    expect(text).toBe("pong");
    expect(next.value.steps).toBe(1);
  });
});
