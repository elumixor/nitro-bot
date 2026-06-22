import { Message, useFinishRender } from "@elumixor/react-message-renderer";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { useEffect, useState } from "react";
import type { OutputGuard } from "./adapters/telegram";
import { getBotContext } from "./als";
import type { ToolLabeler } from "./tool-label";

/**
 * Pull a human-readable message out of whatever the model/provider throws. AI SDK stream `error` parts
 * (and gateway/provider errors) are plain objects like `{ error: { message } }` or `{ message }`, not
 * `Error`s — `String(obj)` on those yields the useless "[object Object]" the user otherwise sees.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    const nested = o.error;
    if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string")
      return (nested as Record<string, unknown>).message as string;
    if (typeof nested === "string") return nested;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export type AgentReplyProps = {
  messages: ModelMessage[];
  /** System prompt (preferred over `role: "system"` messages). Set via `ctx.agent.systemPrompt`. */
  system?: string;
  tools: ToolSet;
  /** Tool names whose calls are not shown in the `🔧 <name>` trail (e.g. `react`). */
  hiddenTools?: readonly string[];
  /** When set, each tool call's trail line is replaced with a short human-readable label (async). */
  describeTool?: ToolLabeler;
  model: LanguageModel;
  maxSteps?: number;
  /** Called when the stream finishes — passes the final text + step count back so callers can run post-middleware. */
  onFinish?: (result: { text: string; steps: number }) => void | Promise<void>;
  /** Streaming output guard. When active for this chat, completed chunks are scrubbed before being sent. */
  guard?: OutputGuard;
};

const MAX_REASONING_PREVIEW = 300;

/**
 * Index just past the last "safe to send" boundary in `text` (end of a sentence or a line), or -1 if none.
 * A sentence terminator only counts when followed by whitespace, so a number like `0.5` mid-stream isn't
 * cut at the dot. Used to release the largest already-complete prefix to the guard at once — under fast
 * streaming the whole reply often arrives before the first guard call returns, so it's checked in one go.
 */
function lastFlushBoundary(text: string): number {
  let boundary = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") boundary = i + 1;
    else if ((c === "." || c === "!" || c === "?") && (text[i + 1] === " " || text[i + 1] === "\n")) boundary = i + 1;
  }
  return boundary;
}

/** Builds the live message body: reasoning (while thinking) + tool-call trail + the streamed answer. */
function compose(reasoning: string, toolLines: string[], answer: string): string {
  const sections: string[] = [];
  if (reasoning && !answer) {
    const preview =
      reasoning.length > MAX_REASONING_PREVIEW ? `${reasoning.slice(-MAX_REASONING_PREVIEW)}…` : reasoning;
    sections.push(`_${preview.trim()}_`);
  }
  if (toolLines.length) sections.push(toolLines.join("\n"));
  if (answer) sections.push(answer);
  return sections.join("\n\n") || "…";
}

export function AgentReply({
  messages,
  system,
  tools,
  hiddenTools,
  describeTool,
  model,
  maxSteps,
  onFinish,
  guard,
}: AgentReplyProps) {
  const [body, setBody] = useState("…");
  const [errored, setErrored] = useState<string | null>(null);
  // When the turn ends with no text (e.g. the bot only reacted), we render nothing so the renderer
  // deletes the in-progress draft instead of leaving a bare "…" or a dangling tool trail.
  const [suppressed, setSuppressed] = useState(false);
  const finish = useFinishRender();

  useEffect(() => {
    let cancelled = false;
    const hidden = new Set(hiddenTools ?? []);
    void (async () => {
      let reasoning = "";
      const toolLines: string[] = [];
      let steps = 0;
      let failed = false;

      const ctx = getBotContext();
      // When a guard is active for this chat we never render the raw stream: only text the guard has
      // cleared (`released`) reaches the UI, so sensitive content is scrubbed before it's ever sent —
      // no send-then-edit. `pending` holds streamed-but-unchecked text; `answer` is the ungated path.
      const gating = Boolean(guard && ctx && guard.active(ctx));
      let answer = "";
      let released = "";
      let pending = "";

      const render = () => {
        if (cancelled) return;
        // Suppress reasoning while gating — it's unchecked text and could itself leak.
        setBody(compose(gating ? "" : reasoning, toolLines, gating ? released : answer));
      };

      // Pull every already-complete chunk out of `pending`, scrub it, and release it. On `final` the
      // trailing remainder (no terminator yet) is flushed too. Calls are serialized via `flushChain`
      // so chunks are released in order even though the guard is async.
      const flush = async (final: boolean) => {
        if (!guard || !ctx) return;
        for (;;) {
          let end = lastFlushBoundary(pending);
          if (end < 0) {
            if (final && pending.length > 0) end = pending.length;
            else break;
          }
          const chunk = pending.slice(0, end);
          pending = pending.slice(end);
          if (!chunk.trim()) {
            released += chunk; // whitespace-only — nothing to scrub, keep spacing
            continue;
          }
          let safe = chunk;
          try {
            safe = await guard.check({ chunk, precedingText: released, ctx });
          } catch (err) {
            // Backstop, not the only defense — never brick the reply on a guard outage; log and pass through.
            console.error("[nitro-bot] output guard error (passing chunk through):", err);
          }
          if (cancelled) return;
          released += safe;
          render();
        }
      };
      let flushChain = Promise.resolve();
      const scheduleFlush = (final: boolean) => {
        flushChain = flushChain.then(() => flush(final));
        return flushChain;
      };

      // Subagent (handoff) tool calls happen inside a delegate tool's execute, off the coordinator's stream.
      // The supervisor reports them here so they still appear in the live `🔧` trail, nested under the delegate.
      if (ctx)
        ctx.agent.reportToolLine = (line: string) => {
          toolLines.push(line);
          render();
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
          const part = raw as {
            type: string;
            text?: string;
            delta?: string;
            toolName?: string;
            input?: unknown;
            args?: unknown;
          };
          switch (part.type) {
            case "text-delta": {
              const delta = part.text ?? part.delta ?? "";
              if (gating) {
                pending += delta;
                void scheduleFlush(false);
              } else {
                answer += delta;
                render();
              }
              break;
            }
            case "reasoning-delta":
              reasoning += part.text ?? part.delta ?? "";
              if (!gating) render();
              break;
            case "tool-call":
              if (part.toolName && !hidden.has(part.toolName)) {
                const toolName = part.toolName;
                const lineIndex = toolLines.length;
                // Show the bare name immediately; if a labeler is configured, swap in a friendly phrase
                // ("Looking up Yehor") once the cheap describe call returns — never block the stream on it.
                toolLines.push(`🔧 \`${toolName}\``);
                if (describeTool) {
                  const description = (tools as Record<string, { description?: string }>)[toolName]?.description;
                  const input = part.input ?? part.args;
                  void describeTool({ name: toolName, description, input })
                    .then((label) => {
                      if (cancelled) return;
                      toolLines[lineIndex] = `🔧 ${label}`;
                      render();
                    })
                    .catch(() => {});
                }
              }
              render();
              break;
            case "error":
              throw new Error(errorMessage((part as { error?: unknown }).error) || "stream error");
            default:
              break;
          }
        }
        if (gating) await scheduleFlush(true); // drain the buffer before we report the final text
        steps = (await result.steps).length;
      } catch (err) {
        if (!cancelled) {
          failed = true;
          setErrored(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          const finalText = gating ? released : answer;
          // No text to send (the turn was a pure tool/react action) → render nothing so no empty "…"
          // message is left behind. The tool trail was useful live; it's not worth persisting on its own.
          if (!failed && !finalText.trim()) setSuppressed(true);
          if (onFinish) {
            try {
              // Report the cleared text when gating so history/logs never store the raw (unscrubbed) reply.
              await onFinish({ text: finalText, steps });
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
  }, [messages, system, tools, hiddenTools, describeTool, model, maxSteps, finish, onFinish, guard]);

  if (errored) return <Message>⚠️ {errored}</Message>;
  // Render nothing on an empty turn so the renderer deletes the draft (no stray "…" message).
  if (suppressed) return null;
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
