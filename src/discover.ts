import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Node, Project, type PropertyAssignment } from "ts-morph";
import type { HttpMethod } from "./chat-handler";

const METHOD_NAMES = ["get", "post", "put", "delete", "patch"] as const;
const METHOD_SET = new Set<string>(METHOD_NAMES);

export type ExtractedSchema = {
  bodyText?: string;
  queryText?: string;
};

export type RouteParam = {
  /** The dynamic segment name — `id` for `[id]`, `statusId` for `[statusId]`. */
  name: string;
  /** Nearest static path segment before the param — `people` for `people/[id]`. Used in the LLM description. */
  collection: string;
};

export type DiscoveredRoute = {
  method: HttpMethod;
  path: string;
  absPath: string;
  params: RouteParam[];
  schema?: ExtractedSchema;
};

export async function discoverToolRoutes(routesDir: string): Promise<DiscoveredRoute[]> {
  const files = await walkTs(routesDir);
  const candidates: { absPath: string; method: HttpMethod; path: string }[] = [];
  for (const absPath of files) {
    const content = await readFile(absPath, "utf8");
    if (!hasToolDefinition(content)) continue;
    const route = routeFromFile(absPath, routesDir);
    if (route) candidates.push({ ...route, absPath });
  }

  if (candidates.length === 0) return [];

  const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
  const results: DiscoveredRoute[] = candidates.map((candidate) => ({
    ...candidate,
    params: paramsFromPath(candidate.path),
    schema: extractHandlerSchema(project, candidate.absPath),
  }));
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

/**
 * Pull the dynamic segments out of a resolved route path (`/people/:id/status/:statusId`) so they can
 * be surfaced as LLM tool inputs. Each param is paired with the nearest preceding static segment, which
 * becomes the human-readable "collection" the param selects from. Catch-all segments (`**:rest`) are
 * skipped — they capture a path remainder, not a single record, so they don't map cleanly to a tool input.
 */
function paramsFromPath(path: string): RouteParam[] {
  const params: RouteParam[] = [];
  let collection = "items";
  for (const segment of path.split("/")) {
    if (!segment) continue;
    if (segment.startsWith("**:")) continue;
    if (segment.startsWith(":")) params.push({ name: segment.slice(1), collection });
    else collection = segment;
  }
  return params;
}

function extractHandlerSchema(project: Project, absPath: string): ExtractedSchema | undefined {
  const sourceFile = project.addSourceFileAtPath(absPath);
  const exportAssign = sourceFile.getExportAssignment((assign) => !assign.isExportEquals());
  if (!exportAssign) return undefined;

  const expression = unwrapCall(exportAssign.getExpression());
  if (!Node.isCallExpression(expression)) return undefined;

  const firstArg = expression.getArguments()[0];
  if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return undefined;

  const bodyProp = firstArg.getProperty("body");
  const queryProp = firstArg.getProperty("query");
  const bodyText = readPropertyText(bodyProp);
  const queryText = readPropertyText(queryProp);

  // If the schema references `definition.input` (DRY pattern), skip autoInput entirely —
  // the tool's own definition.input is used at runtime by buildToolSet.
  if (referencesDefinition(bodyText) || referencesDefinition(queryText)) return undefined;

  if (!bodyText && !queryText) return undefined;
  return { bodyText, queryText };
}

function referencesDefinition(text: string | undefined): boolean {
  return Boolean(text && /\bdefinition\b/.test(text));
}

function unwrapCall(expression: Node | undefined): Node | undefined {
  let current: Node | undefined = expression;
  while (current && Node.isAsExpression(current)) current = current.getExpression();
  return current;
}

function readPropertyText(property: Node | undefined): string | undefined {
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = (property as PropertyAssignment).getInitializer();
  return initializer?.getText();
}
