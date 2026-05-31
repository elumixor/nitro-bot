import { generateText, stepCountIs, tool as tool$1 } from 'ai';
import { d as getBotContext } from './shared/nitro-bot.CQiT-gm9.mjs';
export { a as botTool, c as buildBotToolSet, g as getBot, i as isBotToolDefinition, r as registerBot, s as sendFileBuiltin } from './shared/nitro-bot.CQiT-gm9.mjs';
import { defineEventHandler, getValidatedQuery, readFormData, readValidatedBody } from 'h3';
import { z } from 'zod';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';
import { Project, Node } from 'ts-morph';
import 'node:async_hooks';

function defineTelegramBot(config) {
  return config;
}

async function runAgent(options) {
  const result = await generateText({
    model: options.model,
    system: options.systemPrompt,
    prompt: options.prompt,
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? 8)
  });
  return { text: result.text, steps: result.steps?.length ?? 0 };
}

function botCommand(def) {
  return def;
}

function buildToolSet(routes, invoke) {
  const entries = routes.map((route) => {
    const { definition } = route.module;
    const inputShape = Object.keys(definition.input).length > 0 ? definition.input : route.autoInput ?? definition.input;
    return [
      definition.name,
      tool$1({
        description: definition.description,
        inputSchema: z.object(llmSafeShape(inputShape)),
        execute: async (input) => invoke(route, input)
      })
    ];
  });
  return Object.fromEntries(entries);
}
function llmSafeShape(shape) {
  const out = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = toNullableIfOptional(schema);
  return out;
}
function toNullableIfOptional(schema) {
  const internal = schema;
  if (internal._zod?.def?.type !== "optional") return schema;
  const inner = internal._zod.def.innerType;
  return inner ? inner.nullable() : schema;
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
  if (handler && typeof handler.execute === "function") {
    const event = createSyntheticEvent();
    return await handler.execute(event, useQuery ? void 0 : input, useQuery ? input : void 0);
  }
  const fetcher = globalThis.$fetch;
  if (!fetcher) {
    throw new Error(
      `[nitro-bot] route ${route.path} has no .execute (not built with nitro-client's handler()) and \`$fetch\` is unavailable. Pass a custom \`invoke\` to createChatHandler.`
    );
  }
  return fetcher(route.path, {
    method: route.method,
    ...useQuery ? { query: input } : { body: input }
  });
}
function createSyntheticEvent() {
  const noop = () => {
  };
  const ctx = getBotContext();
  const baseContext = {};
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
  const req = { headers: {}, method: "POST", url: "/", on: noop };
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
    path: "/",
    method: "POST",
    headers: new Headers(),
    web: { request: new Request("http://localhost/") }
  };
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
  return { bodyText, queryText };
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
          `[nitro-bot] bot "${bot.name}": ${bot.preFiles.length} pre, ${bot.postFiles.length} post middleware`
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
    bots.push({ name: entry.name, configFile, preFiles, postFiles, toolFiles, commandFiles });
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
  const needsZodImport = routes.some((route) => route.schema);
  const imports = routes.map((route, index) => `import * as r${index} from ${JSON.stringify(route.absPath.replace(/\.ts$/, ""))};`).join("\n");
  const autoInputDecls = routes.map((route, index) => {
    if (!route.schema) return "";
    const { bodyText, queryText } = route.schema;
    const parts = [queryText, bodyText].filter(Boolean);
    const merged = parts.length === 1 ? parts[0] : `{ ${parts.map((p) => `...(${p})`).join(", ")} }`;
    return `const r${index}_input = ${merged};`;
  }).filter(Boolean).join("\n");
  const toolList = routes.map((route, index) => {
    const fields = [
      `method: ${JSON.stringify(route.method)}`,
      `path: ${JSON.stringify(route.path)}`,
      `module: r${index}`
    ];
    if (route.schema) fields.push(`autoInput: r${index}_input`);
    return `  { ${fields.join(", ")} }`;
  }).join(",\n");
  const configImport = `import userConfig from ${JSON.stringify(configFile.replace(/\.ts$/, ""))};`;
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import { buildToolSet, createChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${imports}
${autoInputDecls ? `
${autoInputDecls}
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
  const preArr = bot.preFiles.map((_, i) => `pre_${i}`).join(", ");
  const postArr = bot.postFiles.map((_, i) => `post_${i}`).join(", ");
  const toolArr = bot.toolFiles.map((_, i) => `botTool_${i}`).join(", ");
  const commandArr = bot.commandFiles.map((f, i) => `{ ...command_${i}, name: command_${i}.name ?? ${JSON.stringify(commandNameFromFile(f))} }`).join(", ");
  const source = `// Generated by @elumixor/nitro-bot \u2014 do not edit.
import { startTelegramBot } from "@elumixor/nitro-bot/runtime";
import { chatConfig, tools } from "#nitro-bot";
import botConfig from ${JSON.stringify(stripExt(bot.configFile))};
${preImports}
${postImports}
${toolImports}
${commandImports}

export default startTelegramBot({
  botConfig,
  name: ${JSON.stringify(bot.name)},
  pre: [${preArr}],
  post: [${postArr}],
  botTools: [${toolArr}],
  commands: [${commandArr}],
  tools,
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

const TOOL_BRAND = Symbol.for("nitro-bot.tool");
function tool(def) {
  return {
    [TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? {}
  };
}
function isToolDefinition(value) {
  return typeof value === "object" && value !== null && value[TOOL_BRAND] === true;
}

const botPre = (fn) => fn;
const botPost = (fn) => fn;

export { botCommand, botPost, botPre, buildToolSet, createChatHandler, defaultInvoke, defineTelegramBot, discoverToolRoutes, getBotContext, isToolDefinition, nitroBotModule, resolveChatConfig, runAgent, tool };
