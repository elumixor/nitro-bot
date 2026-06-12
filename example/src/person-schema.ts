import { z } from "zod";

// A body schema kept in its own module and passed to `handler` as a bare
// identifier (`body: personSchema`) — the case that previously dropped its
// import in the generated chat-handler.
export const personSchema = {
  name: z.string(),
  age: z.number().optional(),
};
