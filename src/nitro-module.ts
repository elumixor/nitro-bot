import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ChatConfig } from "./config";
import { type DiscoveredRoute, discoverToolRoutes, type RouteParam } from "./discover";

type NitroModuleHooks = { hook: (name: string, fn: () => void | Promise<void>) => void };

type NitroLike = {
  options: {
    rootDir: string;
    srcDir: string;
    buildDir: string;
    handlers: Array<{ route: string; method?: string; handler: string }>;
    plugins: string[];
    alias: Record<string, string>;
  };
  hooks: NitroModuleHooks;
};

export type NitroBotModuleOptions = ChatConfig;

type DiscoveredBot = {
  name: string;
  configFile: string;
  preFiles: string[];
  postFiles: string[];
  toolFiles: string[];
  commandFiles: string[];
};

export default function nitroBotModule(config: NitroBotModuleOptions = {}) {
  return async (nitro: NitroLike) => {
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

    // Set NITRO_BOT_DISABLE_BOTS to boot the HTTP `/chat` endpoint without starting any chat bot
    // (useful for E2E/CI where you don't want a live Telegram connection).
    const bots = process.env.NITRO_BOT_DISABLE_BOTS ? [] : await discoverBots(botsDir);
    const pluginFiles: string[] = [];
    for (const bot of bots) {
      const pluginFile = await writeBotPlugin({ buildDir, bot });
      nitro.options.plugins.push(pluginFile);
      pluginFiles.push(pluginFile);

      // Webhook receiver — inert in polling mode (returns 503), live when bot.ts sets `webhook`.
      const webhookFile = await writeBotWebhookHandler({ buildDir, bot });
      nitro.options.handlers.push({ route: `/${bot.name}/webhook`, method: "post", handler: webhookFile });
    }

    if (bots.length > 0) {
      const mwFile = await writeBotContextMiddleware({ buildDir });
      nitro.options.handlers.push({ route: "/**", middleware: true, handler: mwFile } as never);
    }

    nitro.hooks.hook("compiled", () => {
      console.log(`[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${endpoint} (source: ${source})`);
      for (const bot of bots) {
        console.log(
          `[nitro-bot] bot "${bot.name}": ${bot.preFiles.length} pre, ${bot.postFiles.length} post middleware`,
        );
      }
      for (const p of pluginFiles) console.log(`[nitro-bot] bot plugin → ${p}`);
    });
  };
}

async function discoverBots(botsDir: string): Promise<DiscoveredBot[]> {
  if (!(await exists(botsDir))) return [];
  const entries = await readdir(botsDir, { withFileTypes: true });
  const bots: DiscoveredBot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(botsDir, entry.name);
    const configFile = resolve(dir, "bot.ts");
    if (!(await exists(configFile))) {
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

async function scanTools(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
    .sort()
    .map((f) => resolve(dir, f));
}

async function scanMiddleware(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  const files = entries.filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: f, order: orderOf(f) }));
  files.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  return files.map((f) => resolve(dir, f.file));
}

function commandNameFromFile(file: string): string {
  return basename(file)
    .replace(/\.tsx?$/, "")
    .replace(/^\d+\./, "");
}

function orderOf(filename: string): number {
  const match = filename.match(/^(\d+)\./);
  return match ? Number(match[1]) : 999;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeConfigFile({ buildDir, config }: { buildDir: string; config: ChatConfig }): Promise<string> {
  await mkdir(buildDir, { recursive: true });
  const configFile = resolve(buildDir, "chat-config.ts");

  const { model, botsDir: _botsDir, ...plain } = config;
  void _botsDir;

  if (model !== undefined && typeof model !== "string") {
    throw new Error(
      `[nitro-bot] non-string \`model\` is not supported — pass a gateway model id string (e.g. "anthropic/claude-sonnet-4.6").`,
    );
  }

  const plainEntries = Object.entries(plain)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
  const modelLine = typeof model === "string" ? `  model: ${JSON.stringify(model)},\n` : "";

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
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
}: {
  buildDir: string;
  routes: DiscoveredRoute[];
  configFile: string;
}): Promise<string> {
  const handlerFile = resolve(buildDir, "chat-handler.ts");
  const needsZodImport = routes.some((route) => route.params.length > 0 || route.schema);

  const imports = routes
    .map((route, index) => `import * as r${index} from ${JSON.stringify(route.absPath.replace(/\.ts$/, ""))};`)
    .join("\n");

  // Re-emit imports for symbols referenced inside inlined body/query schemas (e.g. Prisma enums), grouped by module.
  const schemaImportsBySpecifier = new Map<string, Set<string>>();
  for (const route of routes)
    for (const imp of route.schema?.imports ?? []) {
      const names = schemaImportsBySpecifier.get(imp.specifier) ?? new Set<string>();
      names.add(imp.name);
      schemaImportsBySpecifier.set(imp.specifier, names);
    }
  const schemaImports = [...schemaImportsBySpecifier]
    .map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};`)
    .join("\n");

  // `_params` (dynamic [id] segments) is kept separate from `_input` (auto-extracted body/query): params are
  // always merged into the tool schema, whereas body/query auto-input yields to a route's explicit definition.input.
  const inputDecls = routes
    .flatMap((route, index) => {
      const decls: string[] = [];
      const paramsText = paramsSchemaText(route.params);
      if (paramsText) decls.push(`const r${index}_params = ${paramsText};`);
      if (route.schema) {
        const parts = [route.schema.queryText, route.schema.bodyText].filter(Boolean) as string[];
        const merged = parts.length === 1 ? parts[0] : `{ ${parts.map((p) => `...(${p})`).join(", ")} }`;
        decls.push(`const r${index}_input = ${merged};`);
      }
      return decls;
    })
    .join("\n");

  const toolList = routes
    .map((route, index) => {
      const fields = [
        `method: ${JSON.stringify(route.method)}`,
        `path: ${JSON.stringify(route.path)}`,
        `module: r${index}`,
      ];
      if (route.schema) fields.push(`autoInput: r${index}_input`);
      if (route.params.length > 0) {
        fields.push(`paramsInput: r${index}_params`);
        fields.push(`params: ${JSON.stringify(route.params.map((p) => p.name))}`);
      }
      return `  { ${fields.join(", ")} }`;
    })
    .join(",\n");

  const configImport = `import userConfig from ${JSON.stringify(configFile.replace(/\.ts$/, ""))};`;

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { buildToolSet, createChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${imports}${schemaImports ? `\n${schemaImports}` : ""}
${inputDecls ? `\n${inputDecls}\n` : ""}
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

/** Build the zod shape source for a route's dynamic segments, e.g. `{ id: z.string().describe("...") }`. */
function paramsSchemaText(params: RouteParam[]): string | undefined {
  if (params.length === 0) return undefined;
  const fields = params
    .map((p) => `${p.name}: z.string().describe(${JSON.stringify(`Selects a single record from "${p.collection}".`)})`)
    .join(", ");
  return `{ ${fields} }`;
}

async function writeRuntimeFile({ buildDir, handlerFile }: { buildDir: string; handlerFile: string }): Promise<string> {
  const runtimeFile = resolve(buildDir, "runtime.ts");
  const handlerImport = handlerFile.replace(/\.ts$/, "");
  const source = `// Generated by @elumixor/nitro-bot — do not edit.
export { tools, chatConfig, toolRoutes } from ${JSON.stringify(handlerImport)};
`;
  await writeFile(runtimeFile, source, "utf8");
  return runtimeFile;
}

async function writeBotContextMiddleware({ buildDir }: { buildDir: string }): Promise<string> {
  const mwFile = resolve(buildDir, "bot-context-middleware.ts");
  const source = `// Generated by @elumixor/nitro-bot — do not edit.
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

async function writeBotPlugin({ buildDir, bot }: { buildDir: string; bot: DiscoveredBot }): Promise<string> {
  const pluginFile = resolve(buildDir, `bot-${bot.name}.ts`);
  const stripExt = (p: string) => p.replace(/\.tsx?$/, "");

  const preImports = bot.preFiles.map((f, i) => `import pre_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const postImports = bot.postFiles.map((f, i) => `import post_${i} from ${JSON.stringify(stripExt(f))};`).join("\n");
  const toolImports = bot.toolFiles
    .map((f, i) => `import botTool_${i} from ${JSON.stringify(stripExt(f))};`)
    .join("\n");
  const commandImports = bot.commandFiles
    .map((f, i) => `import command_${i} from ${JSON.stringify(stripExt(f))};`)
    .join("\n");

  const preArr = bot.preFiles.map((_, i) => `pre_${i}`).join(", ");
  const postArr = bot.postFiles.map((_, i) => `post_${i}`).join(", ");
  const toolArr = bot.toolFiles.map((_, i) => `botTool_${i}`).join(", ");
  // Command name defaults to the file name (me.ts → "me"); explicit `name` in the file wins.
  const commandArr = bot.commandFiles
    .map((f, i) => `{ ...command_${i}, name: command_${i}.name ?? ${JSON.stringify(commandNameFromFile(f))} }`)
    .join(", ");

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
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

async function writeBotWebhookHandler({ buildDir, bot }: { buildDir: string; bot: DiscoveredBot }): Promise<string> {
  const file = resolve(buildDir, `bot-${bot.name}-webhook.ts`);
  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { getBot } from "@elumixor/nitro-bot/runtime";
import { defineEventHandler, sendWebResponse, setResponseStatus, toWebRequest } from "h3";

export default defineEventHandler(async (event) => {
  const entry = getBot(${JSON.stringify(bot.name)});
  if (!entry?.handleUpdate) {
    setResponseStatus(event, 503);
    return { error: "Telegram webhook inactive — bot is running in polling mode." };
  }
  const response = await entry.handleUpdate(toWebRequest(event));
  await sendWebResponse(event, response);
});
`;
  await writeFile(file, source, "utf8");
  return file;
}
