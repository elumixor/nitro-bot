import { botPost } from "@elumixor/nitro-bot";

export default botPost((ctx) => {
  console.log(
    `[nitro-bot] reply to ${ctx.user.id} in ${ctx.thread.id}: ${ctx.agent.result.text.slice(0, 80)}${
      ctx.agent.result.text.length > 80 ? "…" : ""
    } (${ctx.agent.result.steps} step(s))`,
  );
});
