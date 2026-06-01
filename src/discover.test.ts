import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { discoverToolRoutes } from "./discover";

const EXAMPLE_ROUTES = resolve(import.meta.dir, "..", "example", "src", "routes");

describe("discoverToolRoutes against the example app", () => {
  test("finds every tool-marked route and ignores untagged files", async () => {
    const routes = await discoverToolRoutes(EXAMPLE_ROUTES);
    const summary = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(summary).toEqual([
      "DELETE /people/:id",
      "GET /people",
      "GET /weather",
      "PATCH /people/:id/notes/:noteId",
      "POST /add",
      "POST /greet",
    ]);
  });

  test("extracts dynamic segments as params paired with the nearest static collection", async () => {
    const routes = await discoverToolRoutes(EXAMPLE_ROUTES);

    const del = routes.find((r) => r.path === "/people/:id" && r.method === "DELETE");
    expect(del?.params).toEqual([{ name: "id", collection: "people" }]);

    const patch = routes.find((r) => r.path === "/people/:id/notes/:noteId");
    expect(patch?.params).toEqual([
      { name: "id", collection: "people" },
      { name: "noteId", collection: "notes" },
    ]);
  });

  test("static routes carry no params", async () => {
    const routes = await discoverToolRoutes(EXAMPLE_ROUTES);
    expect(routes.find((r) => r.path === "/weather")?.params).toEqual([]);
  });

  test("captures the body schema source from a nitro-client handler default export", async () => {
    const routes = await discoverToolRoutes(EXAMPLE_ROUTES);
    const greet = routes.find((r) => r.path === "/greet");
    expect(greet?.schema?.bodyText).toContain("name: z.string()");
    expect(greet?.schema?.bodyText).toContain("excited: z.boolean().optional()");
    expect(greet?.schema?.queryText).toBeUndefined();
  });

  test("leaves plain h3 routes without an extracted schema", async () => {
    const routes = await discoverToolRoutes(EXAMPLE_ROUTES);
    const weather = routes.find((r) => r.path === "/weather");
    expect(weather?.schema).toBeUndefined();
  });
});
