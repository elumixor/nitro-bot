import { botPre } from "@elumixor/nitro-bot";

export default botPre((ctx) => {
  const who = ctx.user.username ?? ctx.user.firstName ?? ctx.user.id;
  ctx.agent.messages.push({
    role: "system",
    content: `You are talking with ${who} (id ${ctx.user.id}) in a ${ctx.thread.type} chat${
      ctx.thread.title ? ` titled "${ctx.thread.title}"` : ""
    }.`,
  });
});
