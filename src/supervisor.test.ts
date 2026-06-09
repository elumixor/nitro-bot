import { tool as aiTool, type ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineSubagent } from "./subagent";
import { buildCoordinatorTools } from "./supervisor";

function fakeTool(): ToolSet[string] {
  return aiTool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" });
}

const allTools: ToolSet = {
  find_person: fakeTool(),
  set_hours: fakeTool(),
  add_agreement_change: fakeTool(),
  create_transaction: fakeTool(),
};

const subagents = [
  defineSubagent({ name: "time", description: "Hours and agreements." }),
  defineSubagent({ name: "finance", description: "Money." }),
];

const toolSubagent = new Map<string, string>([
  ["set_hours", "time"],
  ["add_agreement_change", "time"],
  ["create_transaction", "finance"],
  // find_person intentionally untagged → shared
]);

describe("buildCoordinatorTools", () => {
  test("coordinator sees shared tools + one delegate per subagent, never grouped tools", () => {
    const coordinator = buildCoordinatorTools({
      subagents,
      allTools,
      toolSubagent,
      hiddenTools: new Set(),
      model: "anthropic/claude-sonnet-4.6",
      maxSteps: 8,
    });

    const names = Object.keys(coordinator).sort();
    expect(names).toEqual(["delegate_to_finance", "delegate_to_time", "find_person"]);
    // Grouped tools are reachable only through their delegate, not directly.
    expect(coordinator.set_hours).toBeUndefined();
    expect(coordinator.create_transaction).toBeUndefined();
  });

  test("a tool tagged to an undeclared subagent falls back to shared", () => {
    const coordinator = buildCoordinatorTools({
      subagents: [defineSubagent({ name: "time", description: "Hours." })],
      allTools: { set_hours: fakeTool(), orphan: fakeTool() },
      toolSubagent: new Map([
        ["set_hours", "time"],
        ["orphan", "ghost"],
      ]),
      hiddenTools: new Set(),
      model: "anthropic/claude-sonnet-4.6",
      maxSteps: 8,
    });

    expect(Object.keys(coordinator).sort()).toEqual(["delegate_to_time", "orphan"]);
  });
});
