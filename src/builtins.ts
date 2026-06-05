import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { botTool } from "./bot-tool";

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
