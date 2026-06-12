import { m as runAgentEventStream, d as buildToolSet, g as defaultInvoke } from './shared/nitro-bot.DGLPJw5h.mjs';
export { a as botTool, c as buildBotToolSet, e as createChatHandler, f as createSessionChatHandler, h as getBot, i as getBotContext, j as isBotToolDefinition, k as registerBot, l as runAgent, n as runAgentStream, o as sendFileBuiltin } from './shared/nitro-bot.DGLPJw5h.mjs';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { Project, Node, SyntaxKind } from 'ts-morph';
import 'zod';
import 'ai';
import 'h3';
import 'node:async_hooks';

function defineTelegramBot(config) {
  return config;
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
  botsDir: "src/bots",
  stream: false
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
  const importMap = buildImportMap(sourceFile);
  const bodyInit = resolveSchemaNode(getInitializer(bodyProp), sourceFile, importMap);
  const queryInit = resolveSchemaNode(getInitializer(queryProp), sourceFile, importMap);
  const bodyText = bodyInit?.getText();
  const queryText = queryInit?.getText();
  if (referencesDefinition(bodyText) || referencesDefinition(queryText)) return void 0;
  if (!bodyText && !queryText) return void 0;
  const initializers = [bodyInit, queryInit].filter((node) => node !== void 0);
  const imports = collectSchemaImports(sourceFile, initializers, absPath);
  return { bodyText, queryText, imports: imports.length > 0 ? imports : void 0 };
}
function getInitializer(prop) {
  return prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : void 0;
}
function resolveSchemaNode(node, sourceFile, importMap) {
  if (!node || !Node.isIdentifier(node)) return node;
  const name = node.getText();
  if (importMap.has(name)) return node;
  const initializer = sourceFile.getVariableDeclaration(name)?.getInitializer();
  return initializer ?? node;
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
    const identifiers = node.getDescendantsOfKind(SyntaxKind.Identifier);
    if (Node.isIdentifier(node)) identifiers.unshift(node);
    for (const identifier of identifiers) {
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
    const endpoint = config.endpoint === void 0 ? "/chat" : config.endpoint;
    const mountChat = endpoint !== false;
    const source = config.source ?? "json";
    const httpMethod = source === "query" ? "GET" : "POST";
    const sessionRel = config.sessionFile ?? "src/chat.ts";
    const sessionAbs = resolve(rootDir, sessionRel);
    const sessionFile = mountChat && await exists(sessionAbs) ? sessionAbs : void 0;
    if (mountChat && config.sessionFile && !sessionFile)
      console.warn(
        `[nitro-bot] sessionFile "${config.sessionFile}" not found at ${sessionAbs} \u2014 using stateless /chat.`
      );
    const stream = config.stream ?? false;
    const configFile = await writeConfigFile({ buildDir, config });
    const handlerFile = await writeHandlerFile({ buildDir, routes, configFile, sessionFile, stream });
    const runtimeFile = await writeRuntimeFile({ buildDir, handlerFile });
    if (mountChat)
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
      if (mountChat) {
        const mode = sessionFile ? `session${stream ? "+stream" : ""}` : "stateless";
        console.log(
          `[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${endpoint} (source: ${source}, ${mode})`
        );
      } else {
        console.log(`[nitro-bot] ${routes.length} tool(s) discovered; /chat handled by the consumer (endpoint: false)`);
      }
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
  configFile,
  sessionFile,
  stream
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
  const handlerImport = sessionFile ? `import { buildToolSet, createSessionChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";` : `import { buildToolSet, createChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";`;
  const sessionImport = sessionFile ? `import chatSession from ${JSON.stringify(sessionFile.replace(/\.tsx?$/, ""))};
` : "";
  const defaultExport = sessionFile ? `export default createSessionChatHandler({
  session: chatSession,
  tools: toolRoutes,
  model: chatConfig.model,
  maxSteps: chatConfig.maxSteps,
  field: chatConfig.field,
  stream: ${stream ? "true" : "false"},
});` : `export default createChatHandler({
  ...chatConfig,
  tools: toolRoutes,
});`;
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
${handlerImport}
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${sessionImport}${imports}${schemaImports ? `
${schemaImports}` : ""}
${inputDecls ? `
${inputDecls}
` : ""}
export const chatConfig = resolveChatConfig(userConfig);

export const toolRoutes: ToolRoute[] = [
${toolList}
];

export const tools = buildToolSet(toolRoutes, defaultInvoke);

${defaultExport}
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

function defineChatSession(def) {
  return def;
}

async function* runAgentSession(opts) {
  const { session, event, message, toolRoutes, model, maxSteps } = opts;
  const resolved = await session.resolve(event, opts.body ?? { message });
  const history = await session.loadHistory?.(resolved, event) ?? [];
  const messages = [...history];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== message) messages.push({ role: "user", content: message });
  const result = yield* runAgentEventStream({
    messages,
    tools: buildToolSet(toolRoutes, defaultInvoke),
    model,
    maxSteps,
    systemPrompt: resolved.systemPrompt,
    conversationId: resolved.conversationId,
    user: resolved.user,
    context: resolved.context
  });
  if (session.save) {
    try {
      await session.save(resolved, { user: message, assistant: result.text }, event);
    } catch (error) {
      console.error("[nitro-bot] chat session save failed:", error);
    }
  }
  return { steps: result.steps };
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

export { botCommand, botPost, botPre, buildToolSet, defaultInvoke, defineChatSession, defineSubagent, defineTelegramBot, discoverToolRoutes, isSubagentDefinition, isToolDefinition, nitroBotModule, resolveChatConfig, runAgentEventStream, runAgentSession, tool };
