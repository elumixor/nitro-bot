import { Message, useFinishRender } from "@elumixor/react-message-renderer";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { useEffect, useState } from "react";

export type AgentReplyProps = {
  messages: ModelMessage[];
  /** System prompt (preferred over `role: "system"` messages). Set via `ctx.agent.systemPrompt`. */
  system?: string;
  tools: ToolSet;
  model: LanguageModel;
  maxSteps?: number;
  /** Called when the stream finishes — passes the final text + step count back so callers can run post-middleware. */
  onFinish?: (result: { text: string; steps: number }) => void | Promise<void>;
};

const MAX_REASONING_PREVIEW = 300;

/** Builds the live message body: reasoning (while thinking) + tool-call trail + the streamed answer. */
function compose(reasoning: string, toolLines: string[], answer: string): string {
  const sections: string[] = [];
  if (reasoning && !answer) {
    const preview = reasoning.length > MAX_REASONING_PREVIEW ? `${reasoning.slice(-MAX_REASONING_PREVIEW)}…` : reasoning;
    sections.push(`_${preview.trim()}_`);
  }
  if (toolLines.length) sections.push(toolLines.join("\n"));
  if (answer) sections.push(answer);
  return sections.join("\n\n") || "…";
}

export function AgentReply({ messages, system, tools, model, maxSteps, onFinish }: AgentReplyProps) {
  const [body, setBody] = useState("…");
  const [errored, setErrored] = useState<string | null>(null);
  const finish = useFinishRender();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let reasoning = "";
      let answer = "";
      const toolLines: string[] = [];
      let steps = 0;

      const render = () => {
        if (!cancelled) setBody(compose(reasoning, toolLines, answer));
      };

      try {
        // System prompt goes to the dedicated `system` option (set via ctx.agent.systemPrompt),
        // never interleaved into `messages` — that's a prompt-injection vector.
        const result = streamText({
          model,
          tools,
          system,
          messages,
          stopWhen: stepCountIs(maxSteps ?? 8),
        });

        for await (const raw of result.fullStream) {
          if (cancelled) return;
          const part = raw as { type: string; text?: string; delta?: string; toolName?: string };
          switch (part.type) {
            case "text-delta":
              answer += part.text ?? part.delta ?? "";
              render();
              break;
            case "reasoning-delta":
              reasoning += part.text ?? part.delta ?? "";
              render();
              break;
            case "tool-call":
              if (part.toolName) toolLines.push(`🔧 \`${part.toolName}\``);
              render();
              break;
            case "error":
              throw new Error(String((part as { error?: unknown }).error ?? "stream error"));
            default:
              break;
          }
        }
        steps = (await result.steps).length;
      } catch (err) {
        if (!cancelled) setErrored(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          if (onFinish) {
            try {
              await onFinish({ text: answer, steps });
            } catch (err) {
              console.error("[nitro-bot] onFinish error:", err);
            }
          }
          void finish();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, system, tools, model, maxSteps, finish, onFinish]);

  if (errored) return <Message>⚠️ {errored}</Message>;
  return <Message>{body}</Message>;
}

/** Renders a single pre-computed markdown message and finishes — used for command replies. */
export function StaticReply({ text }: { text: string }) {
  const finish = useFinishRender();
  useEffect(() => {
    void finish();
  }, [finish]);
  return <Message>{text || "…"}</Message>;
}
