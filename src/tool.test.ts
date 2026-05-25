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

  test("isToolDefinition rejects unrelated objects", () => {
    expect(isToolDefinition({ name: "fake", description: "fake" })).toBe(false);
    expect(isToolDefinition(null)).toBe(false);
    expect(isToolDefinition("string")).toBe(false);
  });
});
