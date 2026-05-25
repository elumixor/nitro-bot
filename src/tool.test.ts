import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { isToolDefinition, tool } from "./tool";

describe("tool()", () => {
  test("returns a branded definition", () => {
    const def = tool({ name: "echo", description: "Echo back input." });
    expect(def.name).toBe("echo");
    expect(def.description).toBe("Echo back input.");
    expect(isToolDefinition(def)).toBe(true);
  });

  test("captures the input zod shape", () => {
    const def = tool({
      name: "lookup",
      description: "Look something up.",
      input: { id: z.string(), limit: z.number().optional() },
    });
    expect(Object.keys(def.input)).toEqual(["id", "limit"]);
  });

  test("derives input from a handler's inputSchemas (body + query merged)", () => {
    const fakeHandler = Object.assign(() => {}, {
      inputSchemas: {
        body: { name: z.string(), excited: z.boolean().optional() },
        query: { trace: z.string().optional() },
      },
    });
    const def = tool({ name: "greet", description: "Greet.", from: fakeHandler });
    expect(Object.keys(def.input).sort()).toEqual(["excited", "name", "trace"]);
  });

  test("derived input falls back to empty shape when handler has none", () => {
    const fakeHandler = Object.assign(() => {}, { inputSchemas: {} });
    const def = tool({ name: "ping", description: "Ping.", from: fakeHandler });
    expect(Object.keys(def.input)).toEqual([]);
  });

  test("isToolDefinition rejects unrelated objects", () => {
    expect(isToolDefinition({ name: "fake", description: "fake" })).toBe(false);
    expect(isToolDefinition(null)).toBe(false);
    expect(isToolDefinition("string")).toBe(false);
  });
});
