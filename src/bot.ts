import { createMemoryState } from "@chat-adapter/state-memory";
import type { LanguageModel, ToolSet } from "ai";
import { type Adapter, Chat, type StateAdapter } from "chat";
import { runAgent } from "./agent";

export type ChatBotOptions = {
  adapters: Record<string, Adapter>;
  tools: ToolSet;
  model: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
  userName?: string;
  state?: StateAdapter;
};

export function createChatBot(options: ChatBotOptions): Chat {
  const bot = new Chat({
    userName: options.userName ?? "nitro-bot",
    adapters: options.adapters,
    state: options.state ?? createDefaultState(),
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

function createDefaultState(): StateAdapter {
  return createMemoryState();
}
