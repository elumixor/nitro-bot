import { defineChatConfig } from "@elumixor/nitro-bot";

export default defineChatConfig({
  endpoint: "/chat",
  source: "json",
  field: "message",
  systemPrompt: "You are a concise assistant. Use the provided tools whenever they cover what the user is asking for.",
});
