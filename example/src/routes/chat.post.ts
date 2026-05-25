import { createChatHandler } from "@elumixor/nitro-bot";
import * as add from "./add.post";
import * as weather from "./weather.get";

export default createChatHandler({
  systemPrompt: "You are a concise assistant. Use the provided tools whenever the user asks for data they cover.",
  tools: [
    { method: "GET", path: "/weather", module: weather },
    { method: "POST", path: "/add", module: add },
  ],
});
