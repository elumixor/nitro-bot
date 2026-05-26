import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type DiscoveredRoute, discoverToolRoutes } from "./discover";

type NitroModuleHooks = { hook: (name: string, fn: () => void | Promise<void>) => void };

type NitroLike = {
  options: {
    rootDir: string;
    srcDir: string;
    buildDir: string;
    handlers: Array<{ route: string; method?: string; handler: string }>;
    plugins: string[];
  };
  hooks: NitroModuleHooks;
};

export type NitroBotModuleOptions = {
  configFile?: string;
};

type Routing = {
  endpoint: string;
  source: "query" | "json" | "form";
  hasTelegram: boolean;
  telegramWebhookPath?: string;
};

export default function nitroBotModule(options: NitroBotModuleOptions = {}) {
  return async (nitro: NitroLike) => {
    const rootDir = nitro.options.rootDir;
    const srcDir = nitro.options.srcDir ?? rootDir;
    const buildDir = nitro.options.buildDir ?? resolve(rootDir, ".nitro");
    const routesDir = resolve(srcDir, "routes");
    const configFile = resolve(rootDir, options.configFile ?? "chat.config.ts");

    const routes = await discoverToolRoutes(routesDir);
    if (routes.length === 0) {
      console.warn("[nitro-bot] No routes with `export const definition = tool(...)` found in", routesDir);
    }

    const routing = await readChatRouting(configFile);
    const httpMethod = routing.source === "query" ? "GET" : "POST";

    const handlerFile = await writeHandlerFile({ buildDir, routes, configFile });
    nitro.options.handlers.push({ route: routing.endpoint, method: httpMethod.toLowerCase(), handler: handlerFile });

    if (routing.hasTelegram) {
      const pluginFile = await writeTelegramPlugin({ buildDir, handlerFile });
      nitro.options.plugins.push(pluginFile);

      if (routing.telegramWebhookPath) {
        const webhookFile = await writeTelegramWebhook({ buildDir, handlerFile });
        nitro.options.handlers.push({
          route: routing.telegramWebhookPath,
          method: "post",
          handler: webhookFile,
        });
      }
    }

    nitro.hooks.hook("compiled", () => {
      const lines = [
        `[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${routing.endpoint} (source: ${routing.source})`,
      ];
      if (routing.hasTelegram) {
        lines.push(
          routing.telegramWebhookPath
            ? `[nitro-bot] Telegram webhook at POST ${routing.telegramWebhookPath}`
            : `[nitro-bot] Telegram long-polling enabled`,
        );
      }
      for (const line of lines) console.log(line);
    });
  };
}

async function readChatRouting(configFile: string): Promise<Routing> {
  const defaults: Routing = { endpoint: "/chat", source: "json", hasTelegram: false };
  if (!existsSync(configFile)) return defaults;
  try {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(configFile, { interopDefault: true });
    const mod = (await jiti.import(configFile)) as {
      default?: { endpoint?: string; source?: Routing["source"]; telegram?: { webhookPath?: string } };
      endpoint?: string;
      source?: Routing["source"];
      telegram?: { webhookPath?: string };
    };
    const config = mod.default ?? mod;
    const telegramToken = config.telegram !== undefined || process.env.TELEGRAM_BOT_TOKEN;
    return {
      endpoint: config.endpoint ?? defaults.endpoint,
      source: config.source ?? defaults.source,
      hasTelegram: Boolean(telegramToken),
      telegramWebhookPath: config.telegram?.webhookPath,
    };
  } catch (error) {
    console.warn("[nitro-bot] Failed to load", configFile, "— falling back to POST JSON /chat.", error);
    return defaults;
  }
}

type WriteOptions = {
  buildDir: string;
  routes: DiscoveredRoute[];
  configFile: string;
};

async function writeHandlerFile({ buildDir, routes, configFile }: WriteOptions): Promise<string> {
  const dir = resolve(buildDir, "nitro-bot");
  await mkdir(dir, { recursive: true });
  const handlerFile = resolve(dir, "chat-handler.ts");

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

  const configImport = existsSync(configFile)
    ? `import userConfig from ${JSON.stringify(configFile.replace(/\.ts$/, ""))};`
    : `const userConfig = {};`;

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { createChatHandler, resolveChatConfig, type ToolRoute } from "@elumixor/nitro-bot";
${needsZodImport ? 'import { z } from "zod";\n' : ""}${configImport}
${imports}
${autoInputDecls ? `\n${autoInputDecls}\n` : ""}
const rawConfig = (userConfig && typeof userConfig === "object" && "default" in (userConfig as object))
  ? (userConfig as { default: Record<string, unknown> }).default
  : (userConfig as Record<string, unknown>);

export const chatConfig = resolveChatConfig(rawConfig as Parameters<typeof resolveChatConfig>[0]);

export const toolRoutes: ToolRoute[] = [
${toolList}
];

export default createChatHandler({
  ...chatConfig,
  tools: toolRoutes,
});
`;

  await writeFile(handlerFile, source, "utf8");
  return handlerFile;
}

async function writeTelegramPlugin({
  buildDir,
  handlerFile,
}: {
  buildDir: string;
  handlerFile: string;
}): Promise<string> {
  const dir = resolve(buildDir, "nitro-bot");
  const pluginFile = resolve(dir, "telegram-plugin.ts");
  const handlerImport = handlerFile.replace(/\.ts$/, "");

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { defineNitroPlugin } from "nitropack/runtime";
import { buildToolSet, createTelegramBot, defaultInvoke } from "@elumixor/nitro-bot";
import { chatConfig, toolRoutes } from ${JSON.stringify(handlerImport)};

let bot: ReturnType<typeof createTelegramBot> | undefined;

export function getTelegramBot() {
  if (!bot) {
    const tools = buildToolSet(toolRoutes, defaultInvoke);
    bot = createTelegramBot({
      tools,
      model: chatConfig.model,
      systemPrompt: chatConfig.systemPrompt,
      maxSteps: chatConfig.maxSteps,
      telegram: chatConfig.telegram,
    });
  }
  return bot;
}

export default defineNitroPlugin(async (nitroApp) => {
  const instance = getTelegramBot();
  await instance.initialize();
  nitroApp.hooks.hook("close", async () => {
    await instance.shutdown();
  });
});
`;

  await writeFile(pluginFile, source, "utf8");
  return pluginFile;
}

async function writeTelegramWebhook({
  buildDir,
  handlerFile,
}: {
  buildDir: string;
  handlerFile: string;
}): Promise<string> {
  const dir = resolve(buildDir, "nitro-bot");
  const webhookFile = resolve(dir, "telegram-webhook.ts");
  const pluginImport = resolve(dir, "telegram-plugin").replace(/\.ts$/, "");
  // We must not import the plugin file directly to avoid double registration.
  // Instead, reuse its exported getTelegramBot accessor.
  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { defineEventHandler, toWebRequest } from "h3";
import { getTelegramBot } from ${JSON.stringify(pluginImport)};

export default defineEventHandler(async (event) => {
  const bot = getTelegramBot();
  const request = toWebRequest(event);
  const response = await bot.webhooks.telegram(request);
  return response;
});
// handlerFile reference (for build dep tracking): ${JSON.stringify(handlerFile)}
`;

  await writeFile(webhookFile, source, "utf8");
  return webhookFile;
}
