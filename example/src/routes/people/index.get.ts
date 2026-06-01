import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";

export const definition = tool({
  name: "get_people",
  description: "List people with their ids.",
});

const people = [
  { id: "p1", name: "Alice" },
  { id: "p2", name: "Bob" },
];

export default handler({}, () => people);
