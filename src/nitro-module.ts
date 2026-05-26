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
  adapterNames: string[];
  webhooks: Record<string, string>;
};

export default function nitroBotModule(options: NitroBotModuleOptions = {}) {
  return async (nitro: NitroLike) => {
    const rootDir = nitro.options.rootDir;
    const srcDir = nitro.options.srcDir ?? rootDir;
    const buildDir = resolve(rootDir, ".nitro-bot");
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

    if (routing.adapterNames.length > 0) {
      const pluginFile = await writeBotPlugin({ buildDir, handlerFile });
      nitro.options.plugins.push(pluginFile);

      for (const [adapterName, webhookPath] of Object.entries(routing.webhooks)) {
        const webhookFile = await writeWebhookRoute({ buildDir, adapterName });
        nitro.options.handlers.push({ route: webhookPath, method: "post", handler: webhookFile });
      }
    }

    nitro.hooks.hook("compiled", () => {
      const lines = [
        `[nitro-bot] ${routes.length} tool(s) mounted at ${httpMethod} ${routing.endpoint} (source: ${routing.source})`,
      ];
      if (routing.adapterNames.length > 0) {
        lines.push(`[nitro-bot] Chat adapters: ${routing.adapterNames.join(", ")}`);
        for (const [name, path] of Object.entries(routing.webhooks))
          lines.push(`[nitro-bot]   ${name} webhook at POST ${path}`);
      }
      for (const line of lines) console.log(line);
    });
  };
}

async function readChatRouting(configFile: string): Promise<Routing> {
  const defaults: Routing = { endpoint: "/chat", source: "json", adapterNames: [], webhooks: {} };
  if (!existsSync(configFile)) return defaults;
  try {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(configFile, { interopDefault: true });
    const mod = (await jiti.import(configFile)) as {
      default?: {
        endpoint?: string;
        source?: Routing["source"];
        adapters?: Record<string, unknown>;
        webhooks?: Record<string, string>;
      };
      endpoint?: string;
      source?: Routing["source"];
      adapters?: Record<string, unknown>;
      webhooks?: Record<string, string>;
    };
    const config = mod.default ?? mod;
    return {
      endpoint: config.endpoint ?? defaults.endpoint,
      source: config.source ?? defaults.source,
      adapterNames: Object.keys(config.adapters ?? {}),
      webhooks: config.webhooks ?? {},
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
  await mkdir(buildDir, { recursive: true });
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

async function writeBotPlugin({ buildDir, handlerFile }: { buildDir: string; handlerFile: string }): Promise<string> {
  const pluginFile = resolve(buildDir, "bot-plugin.ts");
  const handlerImport = handlerFile.replace(/\.ts$/, "");

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import type { Chat } from "chat";
import { defineNitroPlugin } from "nitropack/runtime";
import { buildToolSet, createChatBot, defaultInvoke } from "@elumixor/nitro-bot";
import { chatConfig, toolRoutes } from ${JSON.stringify(handlerImport)};

let bot: Chat | undefined;

export function getChatBot(): Chat {
  if (!bot) {
    const tools = buildToolSet(toolRoutes, defaultInvoke);
    bot = createChatBot({
      tools,
      model: chatConfig.model,
      systemPrompt: chatConfig.systemPrompt,
      maxSteps: chatConfig.maxSteps,
      userName: chatConfig.userName,
      adapters: chatConfig.adapters ?? {},
      state: chatConfig.state,
    });
    bot.registerSingleton();
  }
  return bot;
}

export default defineNitroPlugin(async (nitroApp) => {
  const instance = getChatBot();
  await instance.initialize();
  nitroApp.hooks.hook("close", async () => {
    await instance.shutdown();
  });
});
`;

  await writeFile(pluginFile, source, "utf8");
  return pluginFile;
}

async function writeWebhookRoute({
  buildDir,
  adapterName,
}: {
  buildDir: string;
  adapterName: string;
}): Promise<string> {
  const webhookFile = resolve(buildDir, `webhook-${adapterName}.ts`);
  const pluginImport = resolve(buildDir, "bot-plugin").replace(/\.ts$/, "");

  const source = `// Generated by @elumixor/nitro-bot — do not edit.
import { defineEventHandler, toWebRequest } from "h3";
import { getChatBot } from ${JSON.stringify(pluginImport)};

export default defineEventHandler(async (event) => {
  const bot = getChatBot();
  const webhooks = bot.webhooks as Record<string, (request: Request) => Promise<Response>>;
  const handler = webhooks[${JSON.stringify(adapterName)}];
  if (!handler) throw new Error("nitro-bot: no webhook handler for adapter " + ${JSON.stringify(adapterName)});
  const request = toWebRequest(event);
  return await handler(request);
});
`;

  await writeFile(webhookFile, source, "utf8");
  return webhookFile;
}
