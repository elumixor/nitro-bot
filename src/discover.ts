import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Node, Project, type PropertyAssignment, SyntaxKind } from "ts-morph";
import type { HttpMethod } from "./chat-handler";

const METHOD_NAMES = ["get", "post", "put", "delete", "patch"] as const;
const METHOD_SET = new Set<string>(METHOD_NAMES);

/** An imported symbol referenced inside a route's body/query schema (e.g. a Prisma enum), re-emitted into the generated handler. */
export type SchemaImport = {
  name: string;
  /** Module to import from — bare/aliased specifiers (`services/prisma`) kept verbatim; relative ones resolved to absolute. */
  specifier: string;
};

export type ExtractedSchema = {
  bodyText?: string;
  queryText?: string;
  imports?: SchemaImport[];
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

  // The schema text is inlined verbatim into the generated handler, so any symbol it references
  // (typically a Prisma enum like `z.enum(PersonStatus)`) must be imported there too.
  const initializers = [bodyProp, queryProp]
    .map((prop) =>
      prop && Node.isPropertyAssignment(prop) ? (prop as PropertyAssignment).getInitializer() : undefined,
    )
    .filter((node) => node !== undefined);
  const imports = collectSchemaImports(sourceFile, initializers, absPath);

  return { bodyText, queryText, imports: imports.length > 0 ? imports : undefined };
}

/** Map each imported local name in the file to the module it comes from (named, default, and namespace imports). */
function buildImportMap(sourceFile: ReturnType<Project["addSourceFileAtPath"]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    for (const named of decl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getNameNode().getText();
      map.set(local, specifier);
    }
    const defaultImport = decl.getDefaultImport();
    if (defaultImport) map.set(defaultImport.getText(), specifier);
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport) map.set(namespaceImport.getText(), specifier);
  }
  return map;
}

/** Find which imported symbols the given schema nodes reference, resolving relative specifiers to absolute paths. */
function collectSchemaImports(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  nodes: Node[],
  absPath: string,
): SchemaImport[] {
  const importMap = buildImportMap(sourceFile);
  const found = new Map<string, string>();
  for (const node of nodes) {
    for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = identifier.getText();
      // `z` is always imported by the generated handler; skip it and anything already collected.
      if (name === "z" || found.has(name)) continue;
      const specifier = importMap.get(name);
      if (specifier) found.set(name, specifier);
    }
  }
  return [...found].map(([name, specifier]) => ({
    name,
    specifier: specifier.startsWith(".") ? resolve(dirname(absPath), specifier).replace(/\\/g, "/") : specifier,
  }));
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
