import { defineTelegramBot } from "@elumixor/nitro-bot";
import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in the environment.");

export default defineTelegramBot({
  bot: new Bot(token),
  name: "NitroBot",
  draftStreaming: true,
});
