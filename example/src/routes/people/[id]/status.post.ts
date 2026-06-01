import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";
import { PersonStatus } from "../../../person-status";

export const definition = tool({
  name: "set_person_status",
  description: "Set a person's status.",
});

export default handler({ body: { status: z.enum(PersonStatus) } }, ({ body: { status }, router: { id } }) => ({
  id,
  status,
}));
