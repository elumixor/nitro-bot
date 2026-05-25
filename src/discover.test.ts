import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverToolRoutes } from "./discover";

let routesDir: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "nitro-bot-discover-"));
  routesDir = join(root, "routes");
  await mkdir(join(routesDir, "users"), { recursive: true });

  await writeFile(join(routesDir, "weather.get.ts"), 'export const definition = "stub";\nexport default () => {};');
  await writeFile(
    join(routesDir, "users", "[id].post.ts"),
    'export const definition = "stub";\nexport default () => {};',
  );
  await writeFile(join(routesDir, "internal.get.ts"), "export default () => {};"); // no tool
  await writeFile(join(routesDir, "ignored.txt"), "noise");

  await writeFile(
    join(routesDir, "greet.post.ts"),
    `import { z } from "zod";
import { handler } from "../utils/handler";
export const definition = "stub";
export default handler(
  { body: { name: z.string(), excited: z.boolean().optional() } },
  ({ body }) => ({ greeting: body.name }),
);
`,
  );
});

afterAll(() => {
  // Intentionally leave the tmpdir; the OS will clean it up.
});

describe("discoverToolRoutes", () => {
  test("includes only files that export a tool definition", async () => {
    const routes = await discoverToolRoutes(routesDir);
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(["POST /greet", "POST /users/:id", "GET /weather"]);
  });

  test("extracts the body schema from a nitro-client handler call", async () => {
    const routes = await discoverToolRoutes(routesDir);
    const greet = routes.find((r) => r.path === "/greet");
    expect(greet?.schema?.bodyText).toContain("name: z.string()");
    expect(greet?.schema?.bodyText).toContain("excited: z.boolean().optional()");
    expect(greet?.schema?.queryText).toBeUndefined();
  });

  test("returns no schema for routes that don't use nitro-client's handler", async () => {
    const routes = await discoverToolRoutes(routesDir);
    const weather = routes.find((r) => r.path === "/weather");
    expect(weather?.schema).toBeUndefined();
  });
});
