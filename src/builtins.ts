import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { botTool } from "./bot-tool";
import type { BotHistory } from "./types";

/**
 * Built-in tool auto-registered for Telegram bots (opt out via `builtins: { sendFile: false }`).
 * Mirrors the old hidden `SendFile`: a domain tool returns a file path, the model then calls this to
 * deliver it to the chat. Sends from disk so big blobs never round-trip through the model context.
 */
export const sendFileBuiltin = botTool({
  name: "send_file",
  description:
    "Send a file from disk to the current chat. Use type 'photo' for images (compressed preview), 'document' for everything else. Call this after a tool returns a file path you want the user to receive.",
  input: {
    path: z.string().describe("Path to the file on disk (e.g. a path returned by another tool)."),
    filename: z.string().nullable().describe("Display name, or null to use the file's own name."),
    type: z.enum(["document", "photo"]).describe("'photo' for images, 'document' otherwise."),
  },
  execute: async ({ path, filename, type }, ctx) => {
    const data = await readFile(path);
    const name = filename ?? basename(path);
    if (type === "photo") await ctx.reply.sendPhoto(data, name);
    else await ctx.reply.sendDocument(data, name);
    return `Sent ${name} to the chat.`;
  },
});

/**
 * Built-in tool auto-registered for Telegram bots (opt out via `builtins: { react: false }`). Lets the
 * model acknowledge a message with an emoji reaction instead of a text reply. Telegram only accepts a
 * fixed reaction set (👍 👌 🎉 🙏 💯 …); `✅` is not allowed and falls back to 👍.
 */
export const reactBuiltin = botTool({
  name: "react",
  // Reacting is an acknowledgement, not an action worth narrating — keep it out of the tool trail.
  hidden: true,
  description:
    "React to the user's current message with an emoji (e.g. to acknowledge it's handled) instead of sending text. " +
    "Telegram allows only a fixed set: 👍 👎 ❤ 🔥 🎉 🙏 👌 💯 🏆 (✅ is NOT allowed and becomes 👍). Defaults to 👍.",
  input: { emoji: z.string().nullable().describe("Reaction emoji from Telegram's allowed set, or null for 👍.") },
  execute: async ({ emoji }, ctx) => {
    await ctx.reply.react(emoji ?? "👍");
    return `Reacted with ${emoji ?? "👍"}.`;
  },
});

/**
 * Built-in tool auto-registered when the bot config supplies `history.search`. Lets the agent look
 * past the loaded window — e.g. "what did we decide about invoice 42 last week" — instead of being
 * limited to the prepended recent turns. Backed entirely by the consumer's `search` implementation.
 */
export function searchHistoryBuiltin(search: NonNullable<BotHistory["search"]>) {
  return botTool({
    name: "search_history",
    description:
      "Search earlier messages in THIS conversation for context beyond the few most recent turns. " +
      "Pass a query of keywords to filter (omit to get the most recent messages). Use this to recall " +
      "what the user said or what you did before, rather than guessing.",
    input: {
      query: z.string().nullable().describe("Keywords to match against message text, or null for the most recent."),
      limit: z.number().int().min(1).max(100).nullable().describe("Max messages to return (default 20)."),
    },
    execute: async ({ query, limit }, ctx) => {
      const hits = await search({ query: query ?? undefined, limit: limit ?? 20 }, ctx);
      return hits.length ? hits : "No earlier messages matched.";
    },
  });
}
