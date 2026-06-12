import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { personSchema } from "../../person-schema";

export const definition = tool({
  name: "create_person",
  description: "Create a person.",
});

export default handler({ body: personSchema }, ({ body }) => ({ id: "p3", ...body }));
