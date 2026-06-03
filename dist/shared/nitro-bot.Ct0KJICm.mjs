import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { tool } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';

const botContextStorage = new AsyncLocalStorage();
function getBotContext() {
  return botContextStorage.getStore();
}

const BOT_TOOL_BRAND = Symbol.for("nitro-bot.bot-tool");
function botTool(def) {
  return {
    [BOT_TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? {},
    execute: def.execute
  };
}
function isBotToolDefinition(value) {
  return typeof value === "object" && value !== null && value[BOT_TOOL_BRAND] === true;
}
function buildBotToolSet(defs) {
  const entries = defs.map((def) => {
    return [
      def.name,
      tool({
        description: def.description,
        inputSchema: z.object(def.input),
        execute: async (input) => {
          const ctx = getBotContext();
          if (!ctx) throw new Error(`[nitro-bot] bot tool "${def.name}" was called outside an active bot turn.`);
          return await def.execute(input, ctx);
        }
      })
    ];
  });
  return Object.fromEntries(entries);
}

const sendFileBuiltin = botTool({
  name: "send_file",
  description: "Send a file from disk to the current chat. Use type 'photo' for images (compressed preview), 'document' for everything else. Call this after a tool returns a file path you want the user to receive.",
  input: {
    path: z.string().describe("Path to the file on disk (e.g. a path returned by another tool)."),
    filename: z.string().nullable().describe("Display name, or null to use the file's own name."),
    type: z.enum(["document", "photo"]).describe("'photo' for images, 'document' otherwise.")
  },
  execute: async ({ path, filename, type }, ctx) => {
    const data = await readFile(path);
    const name = filename ?? basename(path);
    if (type === "photo") await ctx.reply.sendPhoto(data, name);
    else await ctx.reply.sendDocument(data, name);
    return `Sent ${name} to the chat.`;
  }
});

const registry = /* @__PURE__ */ new Map();
function registerBot(name, entry) {
  registry.set(name, entry);
}
function getBot(name) {
  if (name) return registry.get(name);
  return registry.values().next().value;
}

export { botTool as a, botContextStorage as b, buildBotToolSet as c, getBotContext as d, getBot as g, isBotToolDefinition as i, registerBot as r, sendFileBuiltin as s };
