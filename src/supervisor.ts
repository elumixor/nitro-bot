import { tool as aiTool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { runAgent } from "./agent";
import { getBotContext } from "./als";
import type { SubagentDefinition } from "./subagent";

const DEFAULT_SUBAGENT_SYSTEM =
  "You are a focused subagent. Complete the delegated task using your tools, then reply with a concise " +
  "summary of what you did — include any ids, amounts, and dates. Do not ask the user questions; act on the " +
  "task exactly as given.";

export type SupervisorOptions = {
  subagents: SubagentDefinition[];
  /** All runnable tools keyed by name (route tools + bot-local tools). */
  allTools: ToolSet;
  /** Tool name → subagent name. Tools absent here (or tagged to an undeclared subagent) are shared. */
  toolSubagent: Map<string, string>;
  /** Tool names hidden from the `🔧` trail. */
  hiddenTools: Set<string>;
  model: LanguageModel;
  maxSteps: number;
};

/**
 * Build the coordinator's tool set under the supervisor/handoff pattern: every shared (untagged) tool,
 * plus one synthetic `delegate_to_<name>` tool per declared subagent. Calling a delegate runs a nested
 * agent loop over that subagent's tools (+ the shared tools) and returns its summary to the coordinator.
 */
export function buildCoordinatorTools(opts: SupervisorOptions): ToolSet {
  const { subagents, allTools, toolSubagent, hiddenTools, model, maxSteps } = opts;
  const declared = new Set(subagents.map((s) => s.name));

  const shared: ToolSet = {};
  const grouped = new Map<string, ToolSet>();
  for (const [name, t] of Object.entries(allTools)) {
    const sa = toolSubagent.get(name);
    if (sa && declared.has(sa)) {
      const set = grouped.get(sa) ?? {};
      set[name] = t;
      grouped.set(sa, set);
    } else {
      if (sa && !declared.has(sa))
        console.warn(
          `[nitro-bot] tool "${name}" is tagged subagent "${sa}", but no such subagent is declared — treating it as shared.`,
        );
      shared[name] = t;
    }
  }

  const coordinator: ToolSet = { ...shared };
  for (const sa of subagents) {
    const own = grouped.get(sa.name) ?? {};
    if (Object.keys(own).length === 0)
      console.warn(`[nitro-bot] subagent "${sa.name}" has no tools tagged to it (it will still see shared tools).`);
    // Subagents see their own tools plus the shared ones (lookups, memory, file sending).
    const subTools = wrapTrail({ ...own, ...shared }, hiddenTools);
    coordinator[`delegate_to_${sa.name}`] = aiTool({
      description: sa.description,
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "A complete, self-contained instruction for the subagent. Include every name, id, date, and amount " +
              "already known from the conversation — the subagent cannot see the chat history.",
          ),
      }),
      execute: async ({ task }: { task: string }) => {
        const result = await runAgent({
          prompt: task,
          tools: subTools,
          model: sa.model ?? model,
          systemPrompt: sa.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM,
          maxSteps: sa.maxSteps ?? maxSteps,
        });
        return result.text;
      },
    });
  }
  return coordinator;
}

/** Wrap each tool's execute so a nested (subagent) call reports a `↳ 🔧 name` line to the live reply trail. */
function wrapTrail(toolset: ToolSet, hidden: Set<string>): ToolSet {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(toolset)) {
    const original = (t as { execute?: (input: unknown, options: unknown) => Promise<unknown> }).execute;
    out[name] = {
      ...(t as object),
      execute: async (input: unknown, options: unknown) => {
        if (!hidden.has(name)) getBotContext()?.agent.reportToolLine?.(`↳ 🔧 \`${name}\``);
        return original ? await original(input, options) : undefined;
      },
    } as ToolSet[string];
  }
  return out;
}

/** System-prompt addendum telling the coordinator how and when to delegate. */
export function delegationGuide(subagents: SubagentDefinition[]): string {
  const lines = subagents.map((s) => `- delegate_to_${s.name}: ${s.description}`);
  return [
    "You coordinate specialized subagents. For any task a subagent covers, call its delegate_to_* tool with a",
    "complete, self-contained `task` string (include names, ids, dates, and amounts — the subagent has no chat",
    "history). Use your own shared tools directly for quick lookups and chat actions. Subagents available:",
    ...lines,
  ].join("\n");
}
