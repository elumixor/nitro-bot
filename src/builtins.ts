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
