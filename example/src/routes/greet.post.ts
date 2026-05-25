import { tool } from "@elumixor/nitro-bot";
import { z } from "zod";
import { handler } from "../utils/handler";

const greetHandler = handler(
  {
    body: {
      name: z.string().describe("The person to greet."),
      excited: z.boolean().optional().describe("Use an exclamation mark."),
    },
  },
  ({ body }) => ({ greeting: `Hello, ${body.name}${body.excited ? "!" : "."}` }),
);

export const definition = tool({
  name: "greet",
  description: "Greet someone by name.",
  from: greetHandler,
});

export default greetHandler;
