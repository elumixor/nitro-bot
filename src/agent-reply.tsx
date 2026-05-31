import { Message, useFinishRender } from "@elumixor/react-message-renderer";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { useEffect, useState } from "react";

export type AgentReplyProps = {
  messages: ModelMessage[];
  tools: ToolSet;
  model: LanguageModel;
  maxSteps?: number;
  /** Called when the stream finishes — passes the final text + step count back so callers can run post-middleware. */
  onFinish?: (result: { text: string; steps: number }) => void | Promise<void>;
};

export function AgentReply({ messages, tools, model, maxSteps, onFinish }: AgentReplyProps) {
  const [text, setText] = useState("");
  const [errored, setErrored] = useState<string | null>(null);
  const finish = useFinishRender();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let final = "";
      let steps = 0;
      try {
        const result = streamText({
          model,
          tools,
          messages,
          stopWhen: stepCountIs(maxSteps ?? 8),
        });
        for await (const delta of result.textStream) {
          if (cancelled) return;
          final += delta;
          setText((prev) => prev + delta);
        }
        steps = (await result.steps).length;
      } catch (err) {
        if (!cancelled) setErrored(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          if (onFinish) {
            try {
              await onFinish({ text: final, steps });
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
  }, [messages, tools, model, maxSteps, finish, onFinish]);

  if (errored) return <Message>⚠️ {errored}</Message>;
  return <Message>{text || "…"}</Message>;
}
