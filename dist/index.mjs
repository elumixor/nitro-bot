import { f as runAgent, d as getBotContext } from './shared/nitro-bot.LsCi58JG.mjs';
export { a as botTool, c as buildBotToolSet, g as getBot, i as isBotToolDefinition, e as registerBot, s as sendFileBuiltin } from './shared/nitro-bot.LsCi58JG.mjs';
import { tool as tool$1, asSchema } from 'ai';
import { defineEventHandler, getValidatedQuery, readFormData, readValidatedBody } from 'h3';
import { z } from 'zod';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { Project, Node, SyntaxKind } from 'ts-morph';
import 'node:async_hooks';

function defineTelegramBot(config) {
  return config;
}

function buildToolSet(routes, invoke) {
  const entries = routes.map((route) => {
    const { definition } = route.module;
    const base = Object.keys(definition.input).length > 0 ? definition.input : route.autoInput ?? definition.input;
    const inputShape = route.paramsInput ? { ...route.paramsInput, ...base } : base;
    const inputSchema = z.object(llmSafeShape(inputShape));
    assertRepresentable(definition.name, inputSchema);
    return [
      definition.name,
      tool$1({
        description: definition.description,
        inputSchema,
        execute: async (input) => invoke(route, input)
      })
    ];
  });
  return Object.fromEntries(entries);
}
function assertRepresentable(toolName, schema) {
  try {
    asSchema(schema).jsonSchema;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[nitro-bot] Tool "${toolName}" has an input schema that cannot be represented in JSON Schema: ${message}. Replace the offending field with a JSON-representable type (e.g. an ISO date string that parses to a Date via \`z.string().transform((v) => new Date(v)).pipe(z.date())\`).`
    );
  }
}
function llmSafeShape(shape) {
  const out = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = llmSafe(schema);
  return out;
}
function defType(schema) {
  return schema._zod?.def?.type;
}
function defOf(schema) {
  return schema._zod?.def ?? {};
}
function withDescription(schema, source) {
  const description = source.description;
  return description ? schema.describe(description) : schema;
}
function llmSafe(schema) {
  switch (defType(schema)) {
    case "date":
      return withDescription(
        z.string().transform((value) => new Date(value)).pipe(z.date()),
        schema
      );
    case "optional": {
      const inner = defOf(schema).innerType;
      return inner ? withDescription(llmSafe(inner).nullable(), schema) : schema;
    }
    case "nullable": {
      const inner = defOf(schema).innerType;
      return inner ? withDescription(llmSafe(inner).nullable(), schema) : schema;
    }
    case "array": {
      const element = defOf(schema).element;
      return element ? withDescription(z.array(llmSafe(element)), schema) : schema;
    }
    case "object": {
      const shape = defOf(schema).shape;
      if (!shape) return schema;
      return withDescription(z.object(llmSafeShape(shape)), schema);
    }
    default:
      return schema;
  }
}
function createChatHandler(options) {
  const invoke = options.invoke ?? defaultInvoke;
  const model = options.model ?? "anthropic/claude-sonnet-4.6";
  const maxSteps = options.maxSteps ?? 8;
  const system = options.systemPrompt;
  const source = options.source ?? "json";
  const field = options.field ?? "message";
  const tools = buildToolSet(options.tools, invoke);
  return defineEventHandler(async (event) => {
    const prompt = await readPrompt(event, source, field);
    const result = await runAgent({ prompt, tools, model, systemPrompt: system, maxSteps });
    const response = { text: result.text, steps: result.steps };
    return response;
  });
}
async function readPrompt(event, source, field) {
  if (source === "query") {
    const schema2 = z.object({ [field]: z.string() });
    const data2 = await getValidatedQuery(event, (raw) => schema2.parse(raw));
    return data2[field];
  }
  if (source === "form") {
    const form = await readFormData(event);
    const value = form.get(field);
    if (typeof value !== "string" || value.length === 0)
      throw Object.assign(new Error(`Form field '${field}' is required.`), { statusCode: 400 });
    return value;
  }
  const schema = z.object({ [field]: z.string() });
  const data = await readValidatedBody(event, (raw) => schema.parse(raw));
  return data[field];
}
async function defaultInvoke(route, input) {
  const handler = route.module.default;
  const useQuery = route.method === "GET" || route.method === "DELETE";
  const { params, rest } = splitParams(input, route.params);
  if (handler && typeof handler.execute === "function") {
    const event = createSyntheticEvent(route.method, { params });
    return await handler.execute(event, useQuery ? void 0 : rest, useQuery ? rest : void 0);
  }
  if (handler) {
    const event = createSyntheticEvent(route.method, useQuery ? { params, query: rest } : { params, body: rest });
    return await handler(event);
  }
  const fetcher = globalThis.$fetch;
  if (!fetcher) {
    throw new Error(
      `[nitro-bot] route ${route.path} has no default handler and \`$fetch\` is unavailable. Pass a custom \`invoke\` to createChatHandler.`
    );
  }
  return fetcher(substituteParams(route.path, params), {
    method: route.method,
    ...useQuery ? { query: rest } : { body: rest }
  });
}
function splitParams(input, paramNames) {
  if (!paramNames?.length || !input || typeof input !== "object") return { params: {}, rest: input };
  const params = {};
  const rest = {};
  for (const [key, value] of Object.entries(input)) {
    if (paramNames.includes(key)) {
      if (value !== void 0 && value !== null) params[key] = String(value);
    } else rest[key] = value;
  }
  return { params, rest };
}
function substituteParams(path, params) {
  return path.replace(/:(\w+)/g, (whole, name) => {
    const value = params[name];
    return value === void 0 ? whole : encodeURIComponent(value);
  });
}
function encodeQuery(query) {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === void 0 || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
function createSyntheticEvent(method = "POST", payload) {
  const noop = () => {
  };
  const ctx = getBotContext();
  const baseContext = {};
  if (payload?.params && Object.keys(payload.params).length > 0) baseContext.params = payload.params;
  if (ctx) {
    baseContext.bot = {
      threadId: ctx.thread.id,
      threadName: ctx.thread.title,
      threadType: ctx.thread.type,
      userId: ctx.user.id,
      userName: ctx.user.username ?? ctx.user.firstName,
      botName: ctx.bot.name,
      botUsername: ctx.bot.username,
      messageId: ctx.message.id,
      replyToId: ctx.message.replyToId
    };
    Object.assign(baseContext, ctx.context);
  }
  const path = `/${encodeQuery(payload?.query)}`;
  const hasBody = !!payload && "body" in payload && payload.body !== void 0;
  const headers = hasBody ? { "content-type": "application/json" } : {};
  const req = { headers, method, url: path, on: noop };
  const res = {
    on: noop,
    once: noop,
    end: noop,
    setHeader: noop,
    getHeader: () => void 0,
    statusCode: 200,
    headersSent: false
  };
  return {
    node: { req, res },
    context: baseContext,
    path,
    _path: path,
    // readRawBody() consumes `_requestBody` first; a plain object is JSON-stringified by h3.
    _requestBody: hasBody ? payload?.body : void 0,
    method,
    headers: new Headers(headers),
    web: { request: new Request(`http://localhost${path}`) }
  };
}

function botCommand(def) {
  return def;
}

const DEFAULT_CONFIG = {
  endpoint: "/chat",
  source: "json",
  field: "message",
  maxSteps: 8,
  model: "anthropic/claude-sonnet-4.6",
  botsDir: "src/bots"
};
function resolveChatConfig(config) {
  return { ...DEFAULT_CONFIG, ...config ?? {} };
}

const METHOD_NAMES = ["get", "post", "put", "delete", "patch"];
const METHOD_SET = new Set(METHOD_NAMES);
async function discoverToolRoutes(routesDir) {
  const files = await walkTs(routesDir);
  const candidates = [];
  for (const absPath of files) {
    const content = await readFile(absPath, "utf8");
    if (!hasToolDefinition(content)) continue;
    const route = routeFromFile(absPath, routesDir);
    if (route) candidates.push({ ...route, absPath });
  }
  if (candidates.length === 0) return [];
  const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
  const results = candidates.map((candidate) => ({
    ...candidate,
    params: paramsFromPath(candidate.path),
    schema: extractHandlerSchema(project, candidate.absPath)
  }));
  results.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return results;
}
async function walkTs(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    let entries;
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
function hasToolDefinition(content) {
  return /export\s+const\s+definition\s*=/.test(content);
}
function routeFromFile(absPath, routesDir) {
  const rel = relative(routesDir, absPath).replace(/\\/g, "/");
  const match = rel.match(/^(.*)\.([a-z]+)\.ts$/);
  if (!match) return null;
  const [, stem, methodLower] = match;
  if (!stem || !methodLower || !METHOD_SET.has(methodLower)) return null;
  let path = `/${stem}`;
  if (path.endsWith("/index")) path = path.slice(0, -"/index".length) || "/";
  path = path.replace(/\[\.\.\.(\w+)\]/g, "**:$1").replace(/\[(\w+)\]/g, ":$1");
  return { method: methodLower.toUpperCase(), path };
}
function paramsFromPath(path) {
  const params = [];
  let collection = "items";
  for (const segment of path.split("/")) {
    if (!segment) continue;
    if (segment.startsWith("**:")) continue;
    if (segment.startsWith(":")) params.push({ name: segment.slice(1), collection });
    else collection = segment;
  }
  return params;
}
function extractHandlerSchema(project, absPath) {
  const sourceFile = project.addSourceFileAtPath(absPath);
  const exportAssign = sourceFile.getExportAssignment((assign) => !assign.isExportEquals());
  if (!exportAssign) return void 0;
  const expression = unwrapCall(exportAssign.getExpression());
  if (!Node.isCallExpression(expression)) return void 0;
  const firstArg = expression.getArguments()[0];
  if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return void 0;
  const bodyProp = firstArg.getProperty("body");
  const queryProp = firstArg.getProperty("query");
  const bodyText = readPropertyText(bodyProp);
  const queryText = readPropertyText(queryProp);
  if (referencesDefinition(bodyText) || referencesDefinition(queryText)) return void 0;
  if (!bodyText && !queryText) return void 0;
  const initializers = [bodyProp, queryProp].map(
    (prop) => prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : void 0
  ).filter((node) => node !== void 0);
  const imports = collectSchemaImports(sourceFile, initializers, absPath);
  return { bodyText, queryText, imports: imports.length > 0 ? imports : void 0 };
}
function buildImportMap(sourceFile) {
  const map = /* @__PURE__ */ new Map();
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
function collectSchemaImports(sourceFile, nodes, absPath) {
  const importMap = buildImportMap(sourceFile);
  const found = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const name = identifier.getText();
      if (name === "z" || found.has(name)) continue;
      const specifier = importMap.get(name);
      if (specifier) found.set(name, specifier);
    }
  }
  return [...found].map(([name, specifier]) => ({
    name,
    specifier: specifier.startsWith(".") ? resolve(dirname(absPath), specifier).replace(/\\/g, "/") : specifier
  }));
}
function referencesDefinition(text) {
  return Boolean(text && /\bdefinition\b/.test(text));
}
function unwrapCall(expression) {
  let current = expression;
  while (current && Node.isAsExpression(current)) current = current.getExpression();
  return current;
}
function readPropertyText(property) {
  if (!property || !Node.isPropertyAssignment(property)) return void 0;
  const initializer = property.getInitializer();
  return initializer?.getText();
}

function nitroBotModule(config = {}) {
  return async (nitro) => {
    const rootDir = nitro.options.rootDir;
    const srcDir = nitro.options.srcDir ?? rootDir;
    const buildDir = resolve(rootDir, ".nitro-bot");
    const routesDir = resolve(srcDir, "routes");
    const botsDir = resolve(rootDir, config.botsDir ?? "src/bots");
    const routes = await discoverToolRoutes(routesDir);
    if (routes.length === 0) {
      console.warn("[nitro-bot] No tool routes with `export const definition = tool(...)` found in", routesDir);
    }
    const endpoint = config.endpoint ?? "/chat";
    const source = config.source ?? "json";
    const httpMethod = source === "query" ? "GET" : "POST";
    const configFile = await writeConfigFile({ buildDir, config });
    const handlerFile = await writeHandlerFile({ buildDir, routes, configFile });
    const runtimeFile = await writeRuntimeFile({ buildDir, handlerFile });
    nitro.options.handlers.push({ route: endpoint, method: httpMethod.toLowerCase(), handler: handlerFile });
    nitro.options.alias ??= {};
    nitro.options.alias["#nitro-bot"] = runtimeFile.replace(/\.ts$/, "");
    const bots = process.env.NITRO_BOT_DISABLE_BOTS ? [] : await discoverBots(botsDir);
    const pluginFiles = [];
    for (const bot of bots) {
      const pluginFile = await writeBotPlugin({ buildDir, bot });
      nitro.options.plugins.push(pluginFile);
      pluginFiles.push(pluginFile);
      const webhookFile = await writeBotWebhookHandler({ buildDir, bot });
      nitro.options.handlers.push({ route: `/${bot.name}/webhook`, method: "post", handler: webhookFile });
    }
    if (bots.length > 0) {
      const mwFile = await writeBotContextMiddleware({ buildDir });
      nitro.options.handlers.push({ route: "/**", middleware: true, handler: mwFile });
    }
    nitro.hooks.hook("compiled", () => {
      console.log(`[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${endpoint} (source: ${source})`);
      for (const bot of bots) {
        console.log(
          `[nitro-bot] bot "${bot.name}": ${bot.preFiles.length} pre, ${bot.postFiles.length} post middleware, ${bot.subagentFiles.length} subagent(s)`
        );
      }
      for (const p of pluginFiles) console.log(`[nitro-bot] bot plugin \u2192 ${p}`);
    });
  };
}
async function discoverBots(botsDir) {
  if (!await exists(botsDir)) return [];
  const entries = await readdir(botsDir, { withFileTypes: true });
  const bots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(botsDir, entry.name);
    const configFile = resolve(dir, "bot.ts");
    if (!await exists(configFile)) {
      console.warn(`[nitro-bot] Skipping ${dir}: no bot.ts found.`);
      continue;
    }
    const preFiles = await scanMiddleware(resolve(dir, "middleware/pre"));
    const postFiles = await scanMiddleware(resolve(dir, "middleware/post"));
    const toolFiles = await scanTools(resolve(dir, "tools"));
    const commandFiles = await scanTools(resolve(dir, "commands"));
    const subagentFiles = await scanTools(resolve(dir, "subagents"));
    bots.push({ name: entry.name, configFile, preFiles, postFiles, toolFiles, commandFiles, subagentFiles });
  }
  return bots;
}
async function scanTools(dir) {
  if (!await exists(dir)) return [];
  const entries = await readdir(dir);
  return entries.filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f)).sort().map((f) => resolve(dir, f));
}
async function scanMiddleware(dir) {
  if (!await exists(dir)) return [];
  const entries = await readdir(dir);
  const files = entries.filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: f, order: orderOf(f) }));
  files.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  return files.map((f) => resolve(dir, f.file));
}
function commandNameFromFile(file) {
  return basename(file).replace(/\.tsx?$/, "").replace(/^\d+\./, "");
}
function orderOf(filename) {
  const match = filename.match(/^(\d+)\./);
  return match ? Number(match[1]) : 999;
}
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function writeConfigFile({ buildDir, config }) {
  await mkdir(buildDir, { recursive: true });
  const configFile = resolve(buildDir, "chat-config.ts");
  const { model, botsDir: _botsDir, ...plain } = config;
  if (model !== void 0 && typeof model !== "string") {
    throw new Error(
      `[nitro-bot] non-string \`model\` is not supported \u2014 pass a gateway model id string (e.g. "anthropic/claude-sonnet-4.6").`
    );
  }
  const plainEntries = Object.entries(plain).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join("\n");
  const modelLine = typeof model === "string" ? `  model: ${JSON.stringify(model)},
` : "";
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import type { ResolvedChatConfig } from "@elumixor/nitro-bot";

const config = {
${plainEntries}${plainEntries ? "\n" : ""}${modelLine}} satisfies Partial<ResolvedChatConfig>;

export default config;
`;
  await writeFile(configFile, source, "utf8");
  return configFile;
}
async function writeHandlerFile({
  buildDir,
  routes,
  configFile
}) {
  const handlerFile = resolve(buildDir, "chat-handler.ts");
  const needsZodImport = routes.some((route) => route.params.length > 0 || route.schema);
  const imports = routes.map((route, index) => `import * as r${index} from ${JSON.stringify(route.absPath.replace(/\.ts$/, ""))};`).join("\n");
  const schemaImportsBySpecifier = /* @__PURE__ */ new Map();
  for (const route of routes)
    for (const imp of route.schema?.imports ?? []) {
      const names = schemaImportsBySpecifier.get(imp.specifier) ?? /* @__PURE__ */ new Set();
      names.add(imp.name);
      schemaImportsBySpecifier.set(imp.specifier, names);
    }
  const schemaImports = [...schemaImportsBySpecifier].map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};`).join("\n");
  const inputDecls = routes.flatMap((route, index) => {
    const decls = [];
    const paramsText = paramsSchemaText(route.params);
    if (paramsText) decls.push(`const r${index}_params = ${paramsText};`);
    if (route.schema) {
      const parts = [route.schema.queryText, route.schema.bodyText].filter(Boolean);
      const merged = parts.length === 1 ? parts[0] : `{ ${parts.map((p) => `...(${p})`).join(", ")} }`;
      decls.push(`const r${index}_input = ${merged};`);
    }
    return decls;
  }).join("\n");
  const toolList = routes.map((route, index) => {
    const fields = [
      `method: ${JSON.stringify(route.method)}`,
      `path: ${JSON.stringify(route.path)}`,
      `module: r${index}`
    ];
    if (route.schema) fields.push(`autoInput: r${index}_input`);
    if (route.params.length > 0) {
      fields.push(`paramsInput: r${index}_params`);
      fields.push(`params: ${JSON.stringify(route.params.map((p) => p.name))}`);
    }
    return `  { ${fields.join(", ")} }`;
  }).join(",\n");
  const configImport = `import userConfig from ${JSON.stringify(configFile.replace(/\.ts$/, ""))};`;
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import { buildToolSet, createChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${imports}${schemaImports ? `
${schemaImports}` : ""}
${inputDecls ? `
${inputDecls}
` : ""}
export const chatConfig = resolveChatConfig(userConfig);

export const toolRoutes: ToolRoute[] = [
${toolList}
];

export const tools = buildToolSet(toolRoutes, defaultInvoke);

export default createChatHandler({
  ...chatConfig,
  tools: toolRoutes,
});
`;
  await writeFile(handlerFile, source, "utf8");
  return handlerFile;
}
function paramsSchemaText(params) {
  if (params.length === 0) return void 0;
  const fields = params.map((p) => `${p.name}: z.string().describe(${JSON.stringify(`Selects a single record from "${p.collection}".`)})`).join(", ");
  return `{ ${fields} }`;
}
async function writeRuntimeFile({ buildDir, handlerFile }) {
  const runtimeFile = resolve(buildDir, "runtime.ts");
  const handlerImport = handlerFile.replace(/\.ts$/, "");
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
export { tools, chatConfig, toolRoutes } from ${JSON.stringify(handlerImport)};
`;
  await writeFile(runtimeFile, source, "utf8");
  return runtimeFile;
}
async function writeBotContextMiddleware({ buildDir }) {
  const mwFile = resolve(buildDir, "bot-context-middleware.ts");
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
// Surfaces bot info onto event.context so tool routes can read it the normal Nitro way:
//   event.context.bot.threadId / threadName / userId / botName / ...
//   event.context.<user-defined fields>  (e.g. event.context.isAdmin)
import { defineEventHandler } from "h3";
import { getBotContext } from "@elumixor/nitro-bot/runtime";

export default defineEventHandler((event) => {
  const ctx = getBotContext();
  if (!ctx) return;

  (event.context as Record<string, unknown>).bot = {
    threadId: ctx.thread.id,
    threadName: ctx.thread.title,
    threadType: ctx.thread.type,
    topicId: ctx.thread.topicId,
    userId: ctx.user.id,
    userName: ctx.user.username ?? ctx.user.firstName,
    botName: ctx.bot.name,
    botUsername: ctx.bot.username,
    messageId: ctx.message.id,
    replyToId: ctx.message.replyToId,
  };

  for (const key in ctx.context) {
    if (!(key in event.context)) (event.context as Record<string, unknown>)[key] = ctx.context[key];
  }
});
`;
  await writeFile(mwFile, source, "utf8");
  return mwFile;
}
async function writeBotPlugin({ buildDir, bot }) {
  const pluginFile = resolve(buildDir, `bot-${bot.name}.ts`);
  const stripExt = (p) => p.replace(/\.tsx?$/, "");
  const preImports = bot.preFiles.map((f, i) => `import pre_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const postImports = bot.postFiles.map((f, i) => `import post_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const toolImports = bot.toolFiles.map((f, i) => `import botTool_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const commandImports = bot.commandFiles.map((f, i) => `import command_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const subagentImports = bot.subagentFiles.map((f, i) => `import subagent_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const preArr = bot.preFiles.map((_, i) => `pre_${i}`).join(", ");
  const postArr = bot.postFiles.map((_, i) => `post_${i}`).join(", ");
  const toolArr = bot.toolFiles.map((_, i) => `botTool_${i}`).join(", ");
  const commandArr = bot.commandFiles.map((f, i) => `{ ...command_${i}, name: command_${i}.name ?? ${JSON.stringify(commandNameFromFile(f))} }`).join(", ");
  const subagentArr = bot.subagentFiles.map((f, i) => `{ ...subagent_${i}, name: subagent_${i}.name || ${JSON.stringify(commandNameFromFile(f))} }`).join(", ");
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import { startTelegramBot } from "@elumixor/nitro-bot/runtime";
import { chatConfig, tools, toolRoutes } from "#nitro-bot";
import botConfig from ${JSON.stringify(stripExt(bot.configFile))};
${preImports}
${postImports}
${toolImports}
${commandImports}
${subagentImports}

export default startTelegramBot({
  botConfig,
  name: ${JSON.stringify(bot.name)},
  pre: [${preArr}],
  post: [${postArr}],
  botTools: [${toolArr}],
  commands: [${commandArr}],
  subagents: [${subagentArr}],
  tools,
  toolRoutes,
  chatConfig,
});
`;
  await writeFile(pluginFile, source, "utf8");
  return pluginFile;
}
async function writeBotWebhookHandler({ buildDir, bot }) {
  const file = resolve(buildDir, `bot-${bot.name}-webhook.ts`);
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import { getBot } from "@elumixor/nitro-bot/runtime";
import { defineEventHandler, sendWebResponse, setResponseStatus, toWebRequest } from "h3";

export default defineEventHandler(async (event) => {
  const entry = getBot(${JSON.stringify(bot.name)});
  if (!entry?.handleUpdate) {
    setResponseStatus(event, 503);
    return { error: "Telegram webhook inactive \u2014 bot is running in polling mode." };
  }
  const response = await entry.handleUpdate(toWebRequest(event));
  await sendWebResponse(event, response);
});
`;
  await writeFile(file, source, "utf8");
  return file;
}

const SUBAGENT_BRAND = Symbol.for("nitro-bot.subagent");
function defineSubagent(def) {
  return {
    [SUBAGENT_BRAND]: true,
    name: def.name ?? "",
    description: def.description,
    systemPrompt: def.systemPrompt,
    model: def.model,
    maxSteps: def.maxSteps
  };
}
function isSubagentDefinition(value) {
  return typeof value === "object" && value !== null && value[SUBAGENT_BRAND] === true;
}

const TOOL_BRAND = Symbol.for("nitro-bot.tool");
function tool(def) {
  return {
    [TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? {},
    hidden: def.hidden,
    subagent: def.subagent
  };
}
function isToolDefinition(value) {
  return typeof value === "object" && value !== null && value[TOOL_BRAND] === true;
}

const botPre = (fn) => fn;
const botPost = (fn) => fn;

export { botCommand, botPost, botPre, buildToolSet, createChatHandler, defaultInvoke, defineSubagent, defineTelegramBot, discoverToolRoutes, getBotContext, isSubagentDefinition, isToolDefinition, nitroBotModule, resolveChatConfig, runAgent, tool };
