import { i as getBotContext, l as runAgent, p as sendFileBuiltin, r as reactBuiltin, s as searchHistoryBuiltin, c as buildBotToolSet, m as makeToolLabeler, b as botContextStorage, k as registerBot } from './shared/nitro-bot.CfWfC6yH.mjs';
export { f as createSessionChatHandler, h as getBot, n as runAgentEventStream, o as runAgentStream } from './shared/nitro-bot.CfWfC6yH.mjs';
import { jsxs, jsx } from 'react/jsx-runtime';
import { useFinishRender, Message } from '@elumixor/react-message-renderer';
import { streamText, stepCountIs, tool } from 'ai';
import { useState, useEffect, createElement } from 'react';
import { TelegramRenderer } from '@elumixor/react-telegram';
import { Bot, InputFile } from 'grammy';
import { z } from 'zod';
import 'node:fs/promises';
import 'node:path';
import 'h3';
import 'node:async_hooks';

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const o = error;
    if (typeof o.message === "string") return o.message;
    const nested = o.error;
    if (nested && typeof nested === "object" && typeof nested.message === "string")
      return nested.message;
    if (typeof nested === "string") return nested;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
const MAX_REASONING_PREVIEW = 300;
function lastFlushBoundary(text) {
  let boundary = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") boundary = i + 1;
    else if ((c === "." || c === "!" || c === "?") && (text[i + 1] === " " || text[i + 1] === "\n")) boundary = i + 1;
  }
  return boundary;
}
function compose(reasoning, toolLines, answer) {
  const sections = [];
  if (reasoning && !answer) {
    const preview = reasoning.length > MAX_REASONING_PREVIEW ? `${reasoning.slice(-MAX_REASONING_PREVIEW)}\u2026` : reasoning;
    sections.push(`_${preview.trim()}_`);
  }
  if (toolLines.length) sections.push(toolLines.join("\n"));
  if (answer) sections.push(answer);
  return sections.join("\n\n") || "\u2026";
}
function AgentReply({
  messages,
  system,
  tools,
  hiddenTools,
  describeTool,
  model,
  maxSteps,
  onFinish,
  guard
}) {
  const [body, setBody] = useState("\u2026");
  const [errored, setErrored] = useState(null);
  const [suppressed, setSuppressed] = useState(false);
  const finish = useFinishRender();
  useEffect(() => {
    let cancelled = false;
    const hidden = new Set(hiddenTools ?? []);
    void (async () => {
      let reasoning = "";
      const toolLines = [];
      let steps = 0;
      let failed = false;
      const ctx = getBotContext();
      const gating = Boolean(guard && ctx && guard.active(ctx));
      let answer = "";
      let released = "";
      let pending = "";
      const render = () => {
        if (cancelled) return;
        setBody(compose(gating ? "" : reasoning, toolLines, gating ? released : answer));
      };
      const flush = async (final) => {
        if (!guard || !ctx) return;
        for (; ; ) {
          let end = lastFlushBoundary(pending);
          if (end < 0) {
            if (final && pending.length > 0) end = pending.length;
            else break;
          }
          const chunk = pending.slice(0, end);
          pending = pending.slice(end);
          if (!chunk.trim()) {
            released += chunk;
            continue;
          }
          let safe = chunk;
          try {
            safe = await guard.check({ chunk, precedingText: released, ctx });
          } catch (err) {
            console.error("[nitro-bot] output guard error (passing chunk through):", err);
          }
          if (cancelled) return;
          released += safe;
          render();
        }
      };
      let flushChain = Promise.resolve();
      const scheduleFlush = (final) => {
        flushChain = flushChain.then(() => flush(final));
        return flushChain;
      };
      if (ctx)
        ctx.agent.reportToolLine = (line) => {
          toolLines.push(line);
          render();
        };
      try {
        const result = streamText({
          model,
          tools,
          system,
          messages,
          stopWhen: stepCountIs(maxSteps ?? 8)
        });
        for await (const raw of result.fullStream) {
          if (cancelled) return;
          const part = raw;
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
                toolLines.push(describeTool ? "\u{1F527} \u2026" : `\u{1F527} \`${toolName}\``);
                if (describeTool) {
                  const description = tools[toolName]?.description;
                  const input = part.input ?? part.args;
                  void describeTool({ name: toolName, description, input }).then((label) => {
                    if (cancelled) return;
                    toolLines[lineIndex] = `\u{1F527} ${label}`;
                    render();
                  }).catch(() => {
                  });
                }
              }
              render();
              break;
            case "error":
              throw new Error(errorMessage(part.error) || "stream error");
            default:
              break;
          }
        }
        if (gating) await scheduleFlush(true);
        steps = (await result.steps).length;
      } catch (err) {
        if (!cancelled) {
          failed = true;
          setErrored(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          const finalText = gating ? released : answer;
          if (!failed && !finalText.trim()) setSuppressed(true);
          if (onFinish) {
            try {
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
  if (errored) return /* @__PURE__ */ jsxs(Message, { children: [
    "\u26A0\uFE0F ",
    errored
  ] });
  if (suppressed) return null;
  return /* @__PURE__ */ jsx(Message, { children: body });
}
function StaticReply({ text }) {
  const finish = useFinishRender();
  useEffect(() => {
    void finish();
  }, [finish]);
  return /* @__PURE__ */ jsx(Message, { children: text || "\u2026" });
}

const DEFAULT_SUBAGENT_SYSTEM = "You are a focused subagent. Complete the delegated task using your tools, then reply with a concise summary of what you did \u2014 include any ids, amounts, and dates. Do not ask the user questions; act on the task exactly as given.";
function buildCoordinatorTools(opts) {
  const { subagents, allTools, toolSubagent, hiddenTools, model, maxSteps } = opts;
  const declared = new Set(subagents.map((s) => s.name));
  const shared = {};
  const grouped = /* @__PURE__ */ new Map();
  for (const [name, t] of Object.entries(allTools)) {
    const sa = toolSubagent.get(name);
    if (sa && declared.has(sa)) {
      const set = grouped.get(sa) ?? {};
      set[name] = t;
      grouped.set(sa, set);
    } else {
      if (sa && !declared.has(sa))
        console.warn(
          `[nitro-bot] tool "${name}" is tagged subagent "${sa}", but no such subagent is declared \u2014 treating it as shared.`
        );
      shared[name] = t;
    }
  }
  const coordinator = { ...shared };
  for (const sa of subagents) {
    const own = grouped.get(sa.name) ?? {};
    if (Object.keys(own).length === 0)
      console.warn(`[nitro-bot] subagent "${sa.name}" has no tools tagged to it (it will still see shared tools).`);
    const subTools = wrapTrail({ ...own, ...shared }, hiddenTools);
    coordinator[`delegate_to_${sa.name}`] = tool({
      description: sa.description,
      inputSchema: z.object({
        task: z.string().describe(
          "A complete, self-contained instruction for the subagent. Include every name, id, date, and amount already known from the conversation \u2014 the subagent cannot see the chat history."
        )
      }),
      execute: async ({ task }) => {
        const result = await runAgent({
          prompt: task,
          tools: subTools,
          model: sa.model ?? model,
          systemPrompt: sa.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM,
          maxSteps: sa.maxSteps ?? maxSteps
        });
        return result.text;
      }
    });
  }
  return coordinator;
}
function wrapTrail(toolset, hidden) {
  const out = {};
  for (const [name, t] of Object.entries(toolset)) {
    const original = t.execute;
    const description = t.description;
    out[name] = {
      ...t,
      execute: async (input, options) => {
        if (!hidden.has(name)) {
          const ctx = getBotContext();
          let line = `\u21B3 \u{1F527} \`${name}\``;
          if (ctx?.agent.describeTool) {
            try {
              line = `\u21B3 \u{1F527} ${await ctx.agent.describeTool({ name, description, input })}`;
            } catch {
            }
          }
          ctx?.agent.reportToolLine?.(line);
        }
        return original ? await original(input, options) : void 0;
      }
    };
  }
  return out;
}
function delegationGuide(subagents) {
  const lines = subagents.map((s) => `- delegate_to_${s.name}: ${s.description}`);
  return [
    "You coordinate specialized subagents. For any task a subagent covers, call its delegate_to_* tool with a",
    "complete, self-contained `task` string (include names, ids, dates, and amounts \u2014 the subagent has no chat",
    "history). Use your own shared tools directly for quick lookups and chat actions. Subagents available:",
    ...lines
  ].join("\n");
}

const defineNitroPlugin = (fn) => fn;
function startTelegramBot(options) {
  const {
    botConfig,
    pre,
    post,
    tools,
    botTools = [],
    toolRoutes = [],
    commands = [],
    subagents = [],
    chatConfig
  } = options;
  const { draftStreaming = true, webhook, onStart } = botConfig;
  if (!botConfig.bot && !botConfig.token)
    throw new Error("[nitro-bot] defineTelegramBot requires either `token` or `bot`.");
  const bot = botConfig.bot ?? new Bot(botConfig.token, botConfig.botInfo ? { botInfo: botConfig.botInfo } : void 0);
  const registryName = options.name ?? "telegram";
  const builtins = [
    ...botConfig.builtins?.sendFile === false ? [] : [sendFileBuiltin],
    ...botConfig.builtins?.react === false ? [] : [reactBuiltin],
    ...botConfig.history?.search ? [searchHistoryBuiltin(botConfig.history.search)] : []
  ];
  const allBotTools = [...builtins, ...botTools];
  const allTools = { ...tools, ...buildBotToolSet(allBotTools) };
  const describeTool = chatConfig.labelModel ? makeToolLabeler(chatConfig.labelModel) : void 0;
  const hiddenTools = [
    ...allBotTools.filter((t) => t.hidden).map((t) => t.name),
    ...toolRoutes.filter((r) => r.module.definition.hidden).map((r) => r.module.definition.name)
  ];
  const toolSubagent = /* @__PURE__ */ new Map();
  for (const r of toolRoutes)
    if (r.module.definition.subagent) toolSubagent.set(r.module.definition.name, r.module.definition.subagent);
  for (const t of allBotTools) if (t.subagent) toolSubagent.set(t.name, t.subagent);
  const coordinatorTools = subagents.length > 0 ? buildCoordinatorTools({
    subagents,
    allTools,
    toolSubagent,
    hiddenTools: new Set(hiddenTools),
    model: chatConfig.model,
    maxSteps: chatConfig.maxSteps
  }) : allTools;
  const namedCommands = commands.filter((c) => Boolean(c.name));
  return defineNitroPlugin(async (nitroApp) => {
    bot.catch((err) => {
      const cause = err.error instanceof Error ? err.error.stack : err.error;
      console.error(`[nitro-bot] error handling update ${err.ctx.update.update_id}:`, cause);
    });
    for (const cmd of namedCommands) {
      bot.command(cmd.name, async (ctx) => {
        try {
          const botCtx = buildBotContext(ctx, botConfig);
          if (!botCtx) return;
          await botContextStorage.run(botCtx, async () => {
            for (const fn of pre) {
              if (await fn(botCtx) === false) return;
            }
            const cmdCtx = Object.assign(botCtx, {
              args: (ctx.match ?? "").toString().trim(),
              invokeTool: async (toolName, input) => {
                const t = allTools[toolName];
                if (!t?.execute) throw new Error(`[nitro-bot] command "${cmd.name}": unknown tool "${toolName}".`);
                return await t.execute(input ?? {}, { toolCallId: `command:${cmd.name}`, messages: [] });
              }
            });
            const text = await cmd.run(cmdCtx);
            const renderer = new TelegramRenderer(ctx, { draftStreaming });
            await renderer.render(createElement(StaticReply, { text }));
          });
        } catch (err) {
          console.error(`[nitro-bot] command "${cmd.name}" error:`, err instanceof Error ? err.stack : err);
          await ctx.reply("\u26A0\uFE0F Command failed.").catch(() => {
          });
        }
      });
    }
    const runTurn = async (ctx, botCtx, userMessage, userText) => {
      botCtx.agent.describeTool = describeTool;
      if (botConfig.history?.load) {
        try {
          botCtx.agent.messages = await botConfig.history.load(botCtx);
        } catch (err) {
          console.error("[nitro-bot] history.load error:", err instanceof Error ? err.stack : err);
        }
      }
      for (const fn of pre) {
        if (await fn(botCtx) === false) return;
      }
      if (subagents.length > 0) {
        const guide = delegationGuide(subagents);
        botCtx.agent.systemPrompt = botCtx.agent.systemPrompt ? `${botCtx.agent.systemPrompt}

${guide}` : guide;
      }
      const messages = [...botCtx.agent.messages, userMessage];
      const renderer = new TelegramRenderer(ctx, { draftStreaming });
      await botContextStorage.run(
        botCtx,
        () => renderer.render(
          createElement(AgentReply, {
            messages,
            system: botCtx.agent.systemPrompt,
            tools: coordinatorTools,
            hiddenTools,
            describeTool,
            model: chatConfig.model,
            maxSteps: chatConfig.maxSteps,
            guard: botConfig.guard,
            onFinish: async (result) => {
              botCtx.agent.result = result;
              if (botConfig.history?.save) {
                try {
                  await botConfig.history.save(botCtx, { user: userText, assistant: result.text });
                } catch (err) {
                  console.error("[nitro-bot] history.save error:", err instanceof Error ? err.stack : err);
                }
              }
              for (const fn of post) {
                try {
                  await fn(botCtx);
                } catch (err) {
                  console.error("[nitro-bot] post-middleware error:", err);
                }
              }
            }
          })
        )
      );
    };
    bot.on("message:text", async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        if (botCtx.message.text.startsWith("/")) return;
        await runTurn(ctx, botCtx, { role: "user", content: botCtx.message.text }, botCtx.message.text);
      } catch (err) {
        console.error("[nitro-bot] message handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("\u26A0\uFE0F Something went wrong handling your message.").catch(() => {
        });
      }
    });
    bot.on(["message:document", "message:photo"], async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        const attachment = await downloadAttachment(ctx, bot.token);
        if (!attachment) return;
        botCtx.message.attachment = attachment;
        const caption = (ctx.message?.caption ?? "").trim();
        const userMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: caption || `(The user sent a ${attachment.kind}: ${attachment.filename}. Decide what to do with it.)`
            },
            { type: "file", data: attachment.bytes, mediaType: attachment.mediaType, filename: attachment.filename }
          ]
        };
        const label = `[${attachment.kind} ${attachment.filename}]`;
        await runTurn(ctx, botCtx, userMessage, caption ? `${label} ${caption}` : label);
      } catch (err) {
        console.error("[nitro-bot] attachment handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("\u26A0\uFE0F Something went wrong handling your file.").catch(() => {
        });
      }
    });
    let closing = false;
    nitroApp.hooks.hook("close", async () => {
      closing = true;
      if (!webhook) await bot.stop().catch(() => {
      });
    });
    const buildWebhookHandler = (hook) => {
      const seenMessages = /* @__PURE__ */ new Map();
      const DEDUPE_TTL_MS = 5 * 6e4;
      return async (req) => {
        if (hook.secret && req.headers.get("x-telegram-bot-api-secret-token") !== hook.secret)
          return new Response("unauthorized", { status: 401 });
        let update;
        try {
          update = await req.json();
        } catch {
          return new Response("bad request", { status: 400 });
        }
        const msg = update.message;
        if (msg?.message_id !== void 0 && msg.chat?.id !== void 0) {
          const key = `${msg.chat.id}:${msg.message_id}`;
          const now = Date.now();
          for (const [k, v] of seenMessages) if (now - v.t > DEDUPE_TTL_MS) seenMessages.delete(k);
          const prior = seenMessages.get(key);
          if (prior) {
            console.error(
              `[nitro-bot] dropping duplicate delivery of ${key}: update ${update.update_id} (already processed as update ${prior.firstUpdateId})`
            );
            return new Response(null, { status: 200 });
          }
          seenMessages.set(key, { firstUpdateId: update.update_id, t: now });
        }
        const processing = bot.handleUpdate(update).catch((err) => console.error("[nitro-bot] handleUpdate error:", err));
        if (hook.awaitProcessing) await processing;
        return new Response(null, { status: 200 });
      };
    };
    let webhookRegistered = false;
    if (webhook && bot.isInited()) {
      if (!/^https:\/\//i.test(webhook.url))
        console.error(`[nitro-bot] webhook.url must be https, got "${webhook.url}" \u2014 receiver not registered.`);
      else {
        registerBot(registryName, { bot, handleUpdate: buildWebhookHandler(webhook) });
        webhookRegistered = true;
      }
    }
    const withRetry = async (label, fn) => {
      let lastErr;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          if (attempt < 5) {
            const backoff = 500 * 2 ** (attempt - 1);
            console.error(`[nitro-bot] ${label} failed (attempt ${attempt}/5), retrying in ${backoff}ms:`, err);
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }
      throw lastErr;
    };
    try {
      const me = bot.isInited() ? bot.botInfo : await withRetry("getMe", () => bot.api.getMe());
      const info = { id: me.id, username: me.username, name: botConfig.name ?? me.first_name };
      if (namedCommands.length > 0)
        await bot.api.setMyCommands(namedCommands.map((c) => ({ command: c.name, description: c.description }))).catch((err) => console.error("[nitro-bot] setMyCommands failed:", err));
      if (onStart) await onStart({ bot, info });
      if (webhook) {
        if (!/^https:\/\//i.test(webhook.url))
          throw new Error(`webhook.url must be an https URL, got "${webhook.url}".`);
        if (!webhookRegistered) {
          await bot.init();
          registerBot(registryName, { bot, handleUpdate: buildWebhookHandler(webhook) });
          webhookRegistered = true;
        }
        await withRetry("setWebhook", () => bot.api.setWebhook(webhook.url, { secret_token: webhook.secret }));
      } else {
        registerBot(registryName, { bot });
        await bot.api.deleteWebhook();
        void bot.start().then(() => {
          if (!closing) console.error("[nitro-bot] polling stopped unexpectedly.");
        }).catch((err) => console.error("[nitro-bot] bot.start failed:", err));
      }
    } catch (err) {
      console.error("[nitro-bot] bot startup failed \u2014 HTTP server stays up, bot disabled:", err);
    }
  });
}
function buildBotContext(ctx, config) {
  const msg = ctx.message;
  if (!msg || !ctx.chat || !ctx.from) return null;
  const chatType = ctx.chat.type;
  const fallbackName = ctx.me?.first_name ?? "bot";
  const reply = {
    sendDocument: async (data, filename, caption) => {
      await ctx.replyWithDocument(new InputFile(data, filename), caption ? { caption } : void 0);
    },
    sendPhoto: async (data, caption) => {
      await ctx.replyWithPhoto(new InputFile(data), caption ? { caption } : void 0);
    },
    sendText: async (text) => {
      await ctx.reply(text);
    },
    react: async (emoji = "\u{1F44D}") => {
      try {
        await ctx.react(emoji);
      } catch {
        if (emoji !== "\u{1F44D}") await ctx.react("\u{1F44D}").catch(() => {
        });
      }
    }
  };
  const topicId = msg.is_topic_message ? msg.message_thread_id : void 0;
  const replyTo = msg.reply_to_message;
  const replyFrom = replyTo?.from;
  const replyToFromName = replyFrom ? [replyFrom.first_name, replyFrom.last_name].filter(Boolean).join(" ") || replyFrom.username : void 0;
  return {
    bot: { name: config.name ?? fallbackName, username: ctx.me?.username },
    message: {
      text: msg.text ?? msg.caption ?? "",
      id: msg.message_id,
      replyToId: replyTo?.message_id,
      replyToText: replyTo?.text ?? replyTo?.caption,
      replyToFromId: replyFrom ? String(replyFrom.id) : void 0,
      replyToFromName,
      repliesToBot: replyFrom ? replyFrom.id === ctx.me?.id : void 0
    },
    user: {
      id: String(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      languageCode: ctx.from.language_code
    },
    thread: {
      id: String(ctx.chat.id),
      type: chatType,
      title: "title" in ctx.chat ? ctx.chat.title : void 0,
      topicId
    },
    agent: { messages: [] },
    reply,
    context: {}
  };
}
async function downloadAttachment(ctx, token) {
  const doc = ctx.message?.document;
  const photo = ctx.message?.photo?.at(-1);
  let fileId;
  let mediaType;
  let filename;
  let kind;
  if (doc) {
    fileId = doc.file_id;
    mediaType = doc.mime_type ?? "application/octet-stream";
    filename = doc.file_name ?? "document";
    kind = "document";
  } else if (photo) {
    fileId = photo.file_id;
    mediaType = "image/jpeg";
    filename = "photo.jpg";
    kind = "photo";
  } else {
    return null;
  }
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), mediaType, filename, kind };
}

export { AgentReply, botContextStorage, getBotContext, registerBot, startTelegramBot };
