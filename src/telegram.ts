import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { LanguageModel, ToolSet } from "ai";
import { Chat } from "chat";
import { runAgent } from "./agent";
import type { TelegramConfig } from "./config";

export type TelegramBotOptions = {
  telegram?: TelegramConfig;
  tools: ToolSet;
  model: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
};

export function createTelegramBot(options: TelegramBotOptions) {
  const tg = options.telegram ?? {};
  const adapter = createTelegramAdapter({
    botToken: tg.token,
    secretToken: tg.secretToken,
    mode: tg.webhookPath ? "webhook" : "polling",
  });

  const bot = new Chat({
    userName: "nitro-bot",
    adapters: { telegram: adapter },
    state: createMemoryState(),
  });

  const reply = async (
    thread: { post: (msg: string) => Promise<unknown>; startTyping?: () => Promise<unknown> },
    message: { text?: string },
  ): Promise<void> => {
    const prompt = message.text?.trim();
    if (!prompt) return;
    await thread.startTyping?.();
    const result = await runAgent({
      prompt,
      tools: options.tools,
      model: options.model,
      systemPrompt: options.systemPrompt,
      maxSteps: options.maxSteps,
    });
    await thread.post(result.text);
  };

  bot.onDirectMessage(reply);
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await reply(thread, message);
  });
  bot.onSubscribedMessage(reply);

  return bot;
}
