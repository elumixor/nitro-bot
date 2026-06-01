import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";

export const definition = tool({
  name: "delete_person",
  description: "Delete a single person.",
});

export default handler({}, ({ router: { id } }) => ({ deleted: id }));
