import { defineChatConfig } from "@elumixor/nitro-bot";

export default defineChatConfig({
  endpoint: "/chat",
  systemPrompt: "You are a concise assistant. Use the provided tools whenever they cover what the user is asking for.",
});
