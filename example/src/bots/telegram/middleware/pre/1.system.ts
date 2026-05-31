import { botPre } from "@elumixor/nitro-bot";

export default botPre((ctx) => {
  ctx.agent.messages.push({
    role: "system",
    content: `You are ${ctx.bot.name}, a concise assistant. Use the provided tools whenever they cover what the user is asking for.`,
  });
});
