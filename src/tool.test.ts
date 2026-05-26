import { describe, expect, test } from "bun:test";
import { isToolDefinition, tool } from "./tool";

describe("isToolDefinition", () => {
  test("distinguishes tool() output from look-alike objects", () => {
    const real = tool({ name: "echo", description: "Echo." });
    expect(isToolDefinition(real)).toBe(true);
    expect(isToolDefinition({ name: "echo", description: "Echo.", input: {} })).toBe(false);
    expect(isToolDefinition(null)).toBe(false);
    expect(isToolDefinition("string")).toBe(false);
  });
});
