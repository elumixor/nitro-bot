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
    hidden: def.hidden,
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
const reactBuiltin = botTool({
  name: "react",
  // Reacting is an acknowledgement, not an action worth narrating — keep it out of the tool trail.
  hidden: true,
  description: "React to the user's current message with an emoji (e.g. to acknowledge it's handled) instead of sending text. Telegram allows only a fixed set: \u{1F44D} \u{1F44E} \u2764 \u{1F525} \u{1F389} \u{1F64F} \u{1F44C} \u{1F4AF} \u{1F3C6} (\u2705 is NOT allowed and becomes \u{1F44D}). Defaults to \u{1F44D}.",
  input: { emoji: z.string().nullable().describe("Reaction emoji from Telegram's allowed set, or null for \u{1F44D}.") },
  execute: async ({ emoji }, ctx) => {
    await ctx.reply.react(emoji ?? "\u{1F44D}");
    return `Reacted with ${emoji ?? "\u{1F44D}"}.`;
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

export { botTool as a, botContextStorage as b, buildBotToolSet as c, getBotContext as d, registerBot as e, getBot as g, isBotToolDefinition as i, reactBuiltin as r, sendFileBuiltin as s };
