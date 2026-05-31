import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export const definition = tool({
  name: "add",
  description: "Add two numbers and return the sum.",
  input: { a: z.number(), b: z.number() },
});

export default handler({ body: definition.input }, ({ body, event }) => {
  console.log("[add] direct invoke? bot:", event.context.bot);
  return { sum: body.a + body.b };
});
