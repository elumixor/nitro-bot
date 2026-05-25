import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HttpMethod } from "./chat-handler";

const METHOD_NAMES = ["get", "post", "put", "delete", "patch"] as const;
const METHOD_SET = new Set<string>(METHOD_NAMES);

export type DiscoveredRoute = {
  method: HttpMethod;
  path: string;
  absPath: string;
};

export async function discoverToolRoutes(routesDir: string): Promise<DiscoveredRoute[]> {
  const files = await walkTs(routesDir);
  const results: DiscoveredRoute[] = [];
  for (const absPath of files) {
    const content = await readFile(absPath, "utf8");
    if (!hasToolDefinition(content)) continue;
    const route = routeFromFile(absPath, routesDir);
    if (route) results.push({ ...route, absPath });
  }
  results.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return results;
}

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const info = await stat(full);
      if (info.isDirectory()) stack.push(full);
      else if (info.isFile() && entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  }
  return out;
}

function hasToolDefinition(content: string): boolean {
  return /export\s+const\s+definition\s*=/.test(content);
}

function routeFromFile(absPath: string, routesDir: string): { method: HttpMethod; path: string } | null {
  const rel = relative(routesDir, absPath).replace(/\\/g, "/");
  const match = rel.match(/^(.*)\.([a-z]+)\.ts$/);
  if (!match) return null;
  const [, stem, methodLower] = match;
  if (!stem || !methodLower || !METHOD_SET.has(methodLower)) return null;
  let path = `/${stem}`;
  if (path.endsWith("/index")) path = path.slice(0, -"/index".length) || "/";
  path = path.replace(/\[\.\.\.(\w+)\]/g, "**:$1").replace(/\[(\w+)\]/g, ":$1");
  return { method: methodLower.toUpperCase() as HttpMethod, path };
}
