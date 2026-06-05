import { jsxs, jsx } from 'react/jsx-runtime';
import { useFinishRender, Message } from '@elumixor/react-message-renderer';
import { streamText, stepCountIs } from 'ai';
import { useState, useEffect, createElement } from 'react';
import { s as sendFileBuiltin, r as reactBuiltin, c as buildBotToolSet, b as botContextStorage, e as registerBot } from './shared/nitro-bot.sKwRz0EI.mjs';
export { g as getBot, d as getBotContext } from './shared/nitro-bot.sKwRz0EI.mjs';
import { TelegramRenderer } from '@elumixor/react-telegram';
import { Bot, InputFile } from 'grammy';
import 'node:fs/promises';
import 'node:path';
import 'zod';
import 'node:async_hooks';

const MAX_REASONING_PREVIEW = 300;
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
function AgentReply({ messages, system, tools, hiddenTools, model, maxSteps, onFinish }) {
  const [body, setBody] = useState("\u2026");
  const [errored, setErrored] = useState(null);
  const finish = useFinishRender();
  useEffect(() => {
    let cancelled = false;
    const hidden = new Set(hiddenTools ?? []);
    void (async () => {
      let reasoning = "";
      let answer = "";
      const toolLines = [];
      let steps = 0;
      const render = () => {
        if (!cancelled) setBody(compose(reasoning, toolLines, answer));
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
            case "text-delta":
              answer += part.text ?? part.delta ?? "";
              render();
              break;
            case "reasoning-delta":
              reasoning += part.text ?? part.delta ?? "";
              render();
              break;
            case "tool-call":
              if (part.toolName && !hidden.has(part.toolName)) toolLines.push(`\u{1F527} \`${part.toolName}\``);
              render();
              break;
            case "error":
              throw new Error(String(part.error ?? "stream error"));
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
  }, [messages, system, tools, hiddenTools, model, maxSteps, finish, onFinish]);
  if (errored) return /* @__PURE__ */ jsxs(Message, { children: [
    "\u26A0\uFE0F ",
    errored
  ] });
  return /* @__PURE__ */ jsx(Message, { children: body });
}
function StaticReply({ text }) {
  const finish = useFinishRender();
  useEffect(() => {
    void finish();
  }, [finish]);
  return /* @__PURE__ */ jsx(Message, { children: text || "\u2026" });
}

const defineNitroPlugin = (fn) => fn;
function startTelegramBot(options) {
  const { botConfig, pre, post, tools, botTools = [], toolRoutes = [], commands = [], chatConfig } = options;
  const { draftStreaming = true, webhook, onStart } = botConfig;
  if (!botConfig.bot && !botConfig.token)
    throw new Error("[nitro-bot] defineTelegramBot requires either `token` or `bot`.");
  const bot = botConfig.bot ?? new Bot(botConfig.token);
  const registryName = options.name ?? "telegram";
  const builtins = [
    ...botConfig.builtins?.sendFile === false ? [] : [sendFileBuiltin],
    ...botConfig.builtins?.react === false ? [] : [reactBuiltin]
  ];
  const allTools = { ...tools, ...buildBotToolSet([...builtins, ...botTools]) };
  const hiddenTools = [
    ...[...builtins, ...botTools].filter((t) => t.hidden).map((t) => t.name),
    ...toolRoutes.filter((r) => r.module.definition.hidden).map((r) => r.module.definition.name)
  ];
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
    bot.on("message:text", async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        if (botCtx.message.text.startsWith("/")) return;
        for (const fn of pre) {
          const result = await fn(botCtx);
          if (result === false) return;
        }
        const messages = [...botCtx.agent.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user" || last.content !== botCtx.message.text) {
          messages.push({ role: "user", content: botCtx.message.text });
        }
        const renderer = new TelegramRenderer(ctx, { draftStreaming });
        await botContextStorage.run(
          botCtx,
          () => renderer.render(
            createElement(AgentReply, {
              messages,
              system: botCtx.agent.systemPrompt,
              tools: allTools,
              hiddenTools,
              model: chatConfig.model,
              maxSteps: chatConfig.maxSteps,
              onFinish: async (result) => {
                botCtx.agent.result = result;
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
      } catch (err) {
        console.error("[nitro-bot] message handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("\u26A0\uFE0F Something went wrong handling your message.").catch(() => {
        });
      }
    });
    let closing = false;
    nitroApp.hooks.hook("close", async () => {
      closing = true;
      if (!webhook) await bot.stop().catch(() => {
      });
    });
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
      const me = await withRetry("getMe", () => bot.api.getMe());
      const info = { id: me.id, username: me.username, name: botConfig.name ?? me.first_name };
      if (namedCommands.length > 0)
        await bot.api.setMyCommands(namedCommands.map((c) => ({ command: c.name, description: c.description }))).catch((err) => console.error("[nitro-bot] setMyCommands failed:", err));
      if (onStart) await onStart({ bot, info });
      if (webhook) {
        if (!/^https:\/\//i.test(webhook.url))
          throw new Error(`webhook.url must be an https URL, got "${webhook.url}".`);
        await bot.init();
        const seenMessages = /* @__PURE__ */ new Map();
        const DEDUPE_TTL_MS = 5 * 6e4;
        const handleUpdate = async (req) => {
          if (webhook.secret && req.headers.get("x-telegram-bot-api-secret-token") !== webhook.secret)
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
          void bot.handleUpdate(update).catch((err) => console.error("[nitro-bot] handleUpdate error:", err));
          return new Response(null, { status: 200 });
        };
        registerBot(registryName, { bot, handleUpdate });
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
  if (!msg?.text || !ctx.chat || !ctx.from) return null;
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
  const replyFrom = msg.reply_to_message?.from;
  return {
    bot: { name: config.name ?? fallbackName, username: ctx.me?.username },
    message: {
      text: msg.text,
      id: msg.message_id,
      replyToId: msg.reply_to_message?.message_id,
      replyToFromId: replyFrom ? String(replyFrom.id) : void 0,
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

export { AgentReply, botContextStorage, registerBot, startTelegramBot };
