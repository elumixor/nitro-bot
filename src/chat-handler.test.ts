import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildToolSet, type ToolRoute } from "./chat-handler";
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

describe("buildToolSet", () => {
  test("registers tools keyed by their definition name", () => {
    const set = buildToolSet([weatherRoute], async () => ({ ok: true }));
    expect(Object.keys(set)).toEqual(["get_weather"]);
    expect(set.get_weather?.description).toBe("Get the weather for a city.");
  });

  test("wires execute to the invoke callback", async () => {
    const calls: Array<{ route: ToolRoute; input: unknown }> = [];
    const set = buildToolSet([weatherRoute], (route, input) => {
      calls.push({ route, input });
      return { city: (input as { city: string }).city, tempCelsius: 21 };
    });

    const result = await set.get_weather?.execute?.(
      { city: "Berlin" },
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool options are not part of the public surface we test.
      {} as any,
    );
    expect(result).toEqual({ city: "Berlin", tempCelsius: 21 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route.path).toBe("/weather");
    expect(calls[0]?.input).toEqual({ city: "Berlin" });
  });
});
