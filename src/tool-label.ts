import { generateText, type LanguageModel } from "ai";

/** A tool call to be described for the live `🔧` trail. */
export type ToolCallInfo = { name: string; description?: string; input: unknown };

/** Turns a tool call into a short, human-readable status line (e.g. "Looking up Yehor"). */
export type ToolLabeler = (call: ToolCallInfo) => Promise<string>;

const SYSTEM =
  "You turn a single tool call into a 2–5 word status line shown to a non-technical chat user while the " +
  'assistant works. Describe what is happening right now in present continuous, e.g. "Looking up Yehor", ' +
  '"Recording 8.5h", "Searching the web", "Saving the report". Prefer real names and values from the ' +
  "arguments over ids or jargon; never echo the raw tool name. Reply with the phrase only — no quotes, no " +
  "trailing punctuation.";

/**
 * Build a labeler backed by a (cheap) model. Each call is one short `generateText`; on any failure the
 * caller falls back to the bare tool name, so labeling never blocks or breaks a reply.
 */
export function makeToolLabeler(model: LanguageModel): ToolLabeler {
  return async ({ name, description, input }) => {
    let args = "";
    try {
      args = JSON.stringify(input);
    } catch {
      args = "";
    }
    if (args.length > 600) args = `${args.slice(0, 600)}…`;
    const { text } = await generateText({
      model,
      system: SYSTEM,
      prompt: `Tool: ${name}\nPurpose: ${description ?? "(none given)"}\nArguments: ${args || "(none)"}`,
    });
    const label = text
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .replace(/[.\s]+$/, "");
    return label || name;
  };
}
