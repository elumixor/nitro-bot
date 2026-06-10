import { generateText, type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";

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

export type StreamAgentOptions = {
  tools: ToolSet;
  model: LanguageModel;
  systemPrompt?: string;
  maxSteps?: number;
  /** Full conversation history (including the current user turn). Takes precedence over `prompt`. */
  messages?: ModelMessage[];
  /** Used only when `messages` is empty — a single user prompt. */
  prompt?: string;
  /** Called for each text chunk as the model streams its final answer. */
  onDelta?: (delta: string) => void;
  /** Called when the model invokes a tool — useful for a live `🔧 <name>` trail. */
  onToolCall?: (name: string) => void;
};

/**
 * Streaming counterpart to {@link runAgent}. Drives an agent loop with `streamText`, forwarding text
 * deltas (and optional tool-call events) through callbacks, and resolves to the final text + step count.
 * Run it inside `botContextStorage.run(ctx, () => runAgentStream(...))` so tool routes see the live
 * BotContext on `event.context` exactly like the Telegram transport.
 */
export async function runAgentStream(options: StreamAgentOptions): Promise<RunAgentResult> {
  const { messages, prompt, onDelta, onToolCall } = options;
  const result = streamText({
    model: options.model,
    system: options.systemPrompt,
    ...(messages && messages.length > 0 ? { messages } : { prompt: prompt ?? "" }),
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? 8),
  });

  let text = "";
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta": {
        // AI SDK v6 exposes the chunk as `text`; v5 used `textDelta`. Support both.
        const delta =
          (part as { text?: string; textDelta?: string }).text ?? (part as { textDelta?: string }).textDelta;
        if (delta) {
          text += delta;
          onDelta?.(delta);
        }
        break;
      }
      case "tool-call":
        onToolCall?.((part as { toolName: string }).toolName);
        break;
      case "error":
        throw (part as { error: unknown }).error;
    }
  }

  const steps = (await result.steps).length;
  return { text: text || (await result.text), steps };
}
