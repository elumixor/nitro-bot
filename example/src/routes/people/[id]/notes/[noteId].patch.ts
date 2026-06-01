import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
import { z } from "zod";

export const definition = tool({
  name: "update_person_note",
  description: "Update a note on a person.",
});

export default handler(
  { body: { text: z.string().describe("The new note text.") } },
  ({ router: { id, noteId }, body }) => ({ id, noteId, text: body.text }),
);
