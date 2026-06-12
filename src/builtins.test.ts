import { describe, expect, test } from "bun:test";
import { searchHistoryBuiltin } from "./builtins";
import type { BotContext, HistoryMessage } from "./types";

const fakeCtx = {} as BotContext;

describe("searchHistoryBuiltin", () => {
  test("exposes a search_history tool", () => {
    const tool = searchHistoryBuiltin(() => []);
    expect(tool.name).toBe("search_history");
    expect(Object.keys(tool.input)).toEqual(["query", "limit"]);
  });

  test("forwards the query and defaults the limit to 20", async () => {
    const calls: { query?: string; limit: number }[] = [];
    const tool = searchHistoryBuiltin((args) => {
      calls.push(args);
      return [];
    });
    await tool.execute({ query: "invoice 42", limit: null }, fakeCtx);
    expect(calls).toEqual([{ query: "invoice 42", limit: 20 }]);
  });

  test("passes through an explicit limit and a null query (most recent)", async () => {
    const calls: { query?: string; limit: number }[] = [];
    const tool = searchHistoryBuiltin((args) => {
      calls.push(args);
      return [];
    });
    await tool.execute({ query: null, limit: 5 }, fakeCtx);
    expect(calls).toEqual([{ query: undefined, limit: 5 }]);
  });

  test("returns hits when found, a friendly string when empty", async () => {
    const hits: HistoryMessage[] = [{ role: "user", content: "hello" }];
    expect(await searchHistoryBuiltin(() => hits).execute({ query: null, limit: null }, fakeCtx)).toEqual(hits);
    expect(await searchHistoryBuiltin(() => []).execute({ query: null, limit: null }, fakeCtx)).toBe(
      "No earlier messages matched.",
    );
  });
});
