import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export const definition = tool({
  name: "greet",
  description: "Greet someone by name.",
});

export default handler(
  {
    body: {
      name: z.string().describe("The person to greet."),
      excited: z.boolean().optional().describe("Use an exclamation mark."),
    },
  },
  ({ body }) => ({ greeting: `Hello, ${body.name}${body.excited ? "!" : "."}` }),
);
