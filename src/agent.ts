import { generateText, type LanguageModel, stepCountIs, type ToolSet } from "ai";

export type RunAgentOptions = {
  prompt: string;
  tools: ToolSet;
  model: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
};

export type RunAgentResult = {
  text: string;
  steps: number;
};

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const result = await generateText({
    model: options.model,
    system: options.systemPrompt,
    prompt: options.prompt,
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? 8),
  });
  return { text: result.text, steps: result.steps?.length ?? 0 };
}
