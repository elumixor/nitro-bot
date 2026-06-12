import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export const definition = tool({
  name: "echo",
  description: "Echo a message back.",
});

// A schema kept in a local const and passed as a bare identifier — the generator
// must inline this initializer, since the const has no definition in the handler.
const echoSchema = { message: z.string(), loud: z.boolean().optional() };

export default handler({ body: echoSchema }, ({ body }) => ({
  echo: body.loud ? `${body.message.toUpperCase()}!` : body.message,
}));
