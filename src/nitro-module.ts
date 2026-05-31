import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatConfig } from "./config";
import { type DiscoveredRoute, discoverToolRoutes } from "./discover";

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

    const bots = await discoverBots(botsDir);
    const pluginFiles: string[] = [];
    for (const bot of bots) {
      const pluginFile = await writeBotPlugin({ buildDir, bot });
      nitro.options.plugins.push(pluginFile);
      pluginFiles.push(pluginFile);
    }

    if (bots.length > 0) {
      const mwFile = await writeBotContextMiddleware({ buildDir });
      nitro.options.handlers.push({ route: "/**", middleware: true, handler: mwFile } as never);
    }

    nitro.hooks.hook("compiled", () => {
      console.log(
        `[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${endpoint} (source: ${source})`,
      );
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
    bots.push({ name: entry.name, configFile, preFiles, postFiles });
  }
  return bots;
}

async function scanMiddleware(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir);
  const files = entries.filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: f, order: orderOf(f) }));
  files.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  return files.map((f) => resolve(dir, f.file));
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

async function writeConfigFile({
  buildDir,
  config,
}: {
  buildDir: string;
  config: ChatConfig;
}): Promise<string> {
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
  const needsZodImport = routes.some((route) => route.schema);

  const imports = routes
    .map((route, index) => `import * as r${index} from ${JSON.stringify(route.absPath.replace(/\.ts$/, ""))};`)
    .join("\n");

  const autoInputDecls = routes
    .map((route, index) => {
      if (!route.schema) return "";
      const { bodyText, queryText } = route.schema;
      const parts = [queryText, bodyText].filter(Boolean) as string[];
      const merged = parts.length === 1 ? parts[0] : `{ ${parts.map((p) => `...(${p})`).join(", ")} }`;
      return `const r${index}_input = ${merged};`;
    })
    .filter(Boolean)
    .join("\n");

  const toolList = routes
    .map((route, index) => {
      const fields = [
        `method: ${JSON.stringify(route.method)}`,
        `path: ${JSON.stringify(route.path)}`,
        `module: r${index}`,
      ];
      if (route.schema) fields.push(`autoInput: r${index}_input`);
      return `  { ${fields.join(", ")} }`;
    })
    .join(",\n");

  const configImport = `import userConfig from ${JSON.stringify(configFile.replace(/\.ts$/, ""))};`;

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { buildToolSet, createChatHandler, defaultInvoke, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${imports}
${autoInputDecls ? `\n${autoInputDecls}\n` : ""}
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

async function writeRuntimeFile({
  buildDir,
  handlerFile,
}: {
  buildDir: string;
  handlerFile: string;
}): Promise<string> {
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

async function writeBotPlugin({
  buildDir,
  bot,
}: {
  buildDir: string;
  bot: DiscoveredBot;
}): Promise<string> {
  const pluginFile = resolve(buildDir, `bot-${bot.name}.ts`);
  const stripExt = (p: string) => p.replace(/\.tsx?$/, "");

  const preImports = bot.preFiles
    .map((f, i) => `import pre_${i} from ${JSON.stringify(stripExt(f))};`)
    .join("\n");
  const postImports = bot.postFiles
    .map((f, i) => `import post_${i} from ${JSON.stringify(stripExt(f))};`)
    .join("\n");

  const preArr = bot.preFiles.map((_, i) => `pre_${i}`).join(", ");
  const postArr = bot.postFiles.map((_, i) => `post_${i}`).join(", ");

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { startTelegramBot } from "@elumixor/nitro-bot/runtime";
import { chatConfig, tools } from "#nitro-bot";
import botConfig from ${JSON.stringify(stripExt(bot.configFile))};
${preImports}
${postImports}

export default startTelegramBot({
  botConfig,
  pre: [${preArr}],
  post: [${postArr}],
  tools,
  chatConfig,
});
`;

  await writeFile(pluginFile, source, "utf8");
  return pluginFile;
}
