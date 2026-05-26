import { defineChatConfig } from "@elumixor/nitro-bot";
import { createTelegramAdapter } from "@chat-adapter/telegram";

export default defineChatConfig({
  endpoint: "/chat",
  source: "json",
  field: "message",
  systemPrompt: "You are a concise assistant. Use the provided tools whenever they cover what the user is asking for.",
  adapters: {
    telegram: createTelegramAdapter({ mode: "polling" }),
    // slack: createSlackAdapter({ signingSecret: ... }),
    // discord: createDiscordAdapter({ publicKey: ..., botToken: ... }),
  },
  webhooks: {
    // telegram: "/telegram/webhook",
    // slack: "/slack/events",
  },
});
