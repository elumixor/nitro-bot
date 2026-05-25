import { tool } from "@elumixor/nitro-bot";
import { defineEventHandler, readBody } from "h3";
import { z } from "zod";

export const definition = tool({
  name: "add",
  description: "Add two numbers and return the sum.",
  input: { a: z.number(), b: z.number() },
});

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as { a: number; b: number };
  return { sum: body.a + body.b };
});
