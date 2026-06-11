import { TelegramRenderer } from "@elumixor/react-telegram";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { Bot, type Context, InputFile } from "grammy";
import { createElement } from "react";
import type { TelegramBotConfig } from "./adapters/telegram";
import { AgentReply, StaticReply } from "./agent-reply";
import { botContextStorage } from "./als";
import { type AnyBotTool, buildBotToolSet } from "./bot-tool";
import { reactBuiltin, sendFileBuiltin } from "./builtins";
import type { ToolRoute } from "./chat-handler";
import type { BotCommandDef, CommandContext } from "./command";
import { registerBot } from "./registry";
import type { SubagentDefinition } from "./subagent";
import { buildCoordinatorTools, delegationGuide } from "./supervisor";
import type { BotContext, BotPostFn, BotPreFn, ChatReply } from "./types";

type ExecutableTool = { execute?: (input: unknown, options: unknown) => Promise<unknown> };

type NitroApp = { hooks: { hook(name: "close", fn: () => unknown): void } };
const defineNitroPlugin = <T extends (app: NitroApp) => unknown | Promise<unknown>>(fn: T): T => fn;

export type StartTelegramBotOptions = {
  botConfig: TelegramBotConfig;
  pre: BotPreFn[];
  post: BotPostFn[];
  tools: ToolSet;
  /** Chat-only tools discovered under `src/bots/<name>/tools` (can send files, etc.). */
  botTools?: AnyBotTool[];
  /** Route tool metadata — only consulted for per-tool flags like `hidden` (the runnable set is `tools`). */
  toolRoutes?: ToolRoute[];
  /** Slash commands discovered under `src/bots/<name>/commands` — run directly, bypassing the agent. */
  commands?: BotCommandDef[];
  /** Subagents discovered under `src/bots/<name>/subagents` — tools tagged `subagent: "<name>"` route to these. */
  subagents?: SubagentDefinition[];
  /** Registry key — the bot folder name (e.g. "telegram"). Used by getBot() and the webhook route. */
  name?: string;
  chatConfig: { model: LanguageModel; maxSteps: number };
};

export function startTelegramBot(options: StartTelegramBotOptions) {
  const {
    botConfig,
    pre,
    post,
    tools,
    botTools = [],
    toolRoutes = [],
    commands = [],
    subagents = [],
    chatConfig,
  } = options;
  const { draftStreaming = true, webhook, onStart } = botConfig;
  if (!botConfig.bot && !botConfig.token)
    throw new Error("[nitro-bot] defineTelegramBot requires either `token` or `bot`.");
  const bot = botConfig.bot ?? new Bot(botConfig.token as string);
  const registryName = options.name ?? "telegram";

  const builtins = [
    ...(botConfig.builtins?.sendFile === false ? [] : [sendFileBuiltin]),
    ...(botConfig.builtins?.react === false ? [] : [reactBuiltin]),
  ];
  const allBotTools = [...builtins, ...botTools];
  const allTools: ToolSet = { ...tools, ...buildBotToolSet(allBotTools) };

  // Tools flagged `hidden` (e.g. `react`) still run, but their call isn't narrated in the `🔧 <name>` trail.
  const hiddenTools = [
    ...allBotTools.filter((t) => t.hidden).map((t) => t.name),
    ...toolRoutes.filter((r) => r.module.definition.hidden).map((r) => r.module.definition.name),
  ];

  // Supervisor/handoff routing: when subagents are declared, the coordinator only sees shared (untagged)
  // tools plus one `delegate_to_<name>` handoff per subagent; each handoff runs a nested agent over the
  // subagent's own tools. With no subagents, the coordinator keeps the full flat tool set (backward compatible).
  const toolSubagent = new Map<string, string>();
  for (const r of toolRoutes)
    if (r.module.definition.subagent) toolSubagent.set(r.module.definition.name, r.module.definition.subagent);
  for (const t of allBotTools) if (t.subagent) toolSubagent.set(t.name, t.subagent);

  const coordinatorTools =
    subagents.length > 0
      ? buildCoordinatorTools({
          subagents,
          allTools,
          toolSubagent,
          hiddenTools: new Set(hiddenTools),
          model: chatConfig.model,
          maxSteps: chatConfig.maxSteps,
        })
      : allTools;

  // The module fills `name` from the file name; only commands with a resolved name can be registered.
  const namedCommands = commands.filter((c): c is BotCommandDef & { name: string } => Boolean(c.name));

  return defineNitroPlugin(async (nitroApp) => {
    // Never let a single failed update stop the bot. Without this, an error in a tool/middleware
    // throws out of the handler, grammy logs "No error handler was set!" and stops polling.
    bot.catch((err) => {
      const cause = err.error instanceof Error ? err.error.stack : err.error;
      console.error(`[nitro-bot] error handling update ${err.ctx.update.update_id}:`, cause);
    });

    // Slash commands run directly (no agent). Registered before the chat handler so grammy matches
    // them first; the chat handler also skips any leading-"/" text so a command never reaches the LLM.
    for (const cmd of namedCommands) {
      bot.command(cmd.name, async (ctx) => {
        try {
          const botCtx = buildBotContext(ctx, botConfig);
          if (!botCtx) return;
          await botContextStorage.run(botCtx, async () => {
            for (const fn of pre) {
              if ((await fn(botCtx)) === false) return;
            }
            const cmdCtx: CommandContext = Object.assign(botCtx, {
              args: (ctx.match ?? "").toString().trim(),
              invokeTool: async (toolName: string, input?: unknown) => {
                const t = (allTools as Record<string, ExecutableTool>)[toolName];
                if (!t?.execute) throw new Error(`[nitro-bot] command "${cmd.name}": unknown tool "${toolName}".`);
                return await t.execute(input ?? {}, { toolCallId: `command:${cmd.name}`, messages: [] });
              },
            });
            const text = await cmd.run(cmdCtx);
            const renderer = new TelegramRenderer(ctx, { draftStreaming } as ConstructorParameters<
              typeof TelegramRenderer
            >[1]);
            await renderer.render(createElement(StaticReply, { text }));
          });
        } catch (err) {
          console.error(`[nitro-bot] command "${cmd.name}" error:`, err instanceof Error ? err.stack : err);
          await ctx.reply("⚠️ Command failed.").catch(() => {});
        }
      });
    }

    bot.on("message:text", async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        // Slash commands are handled above — don't also route them through the agent.
        if (botCtx.message.text.startsWith("/")) return;

        for (const fn of pre) {
          const result = await fn(botCtx);
          if (result === false) return;
        }

        // With subagents declared, teach the coordinator to delegate (appended after middleware sets the base prompt).
        if (subagents.length > 0) {
          const guide = delegationGuide(subagents);
          botCtx.agent.systemPrompt = botCtx.agent.systemPrompt ? `${botCtx.agent.systemPrompt}\n\n${guide}` : guide;
        }

        const messages: ModelMessage[] = [...botCtx.agent.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "user" || last.content !== botCtx.message.text) {
          messages.push({ role: "user", content: botCtx.message.text });
        }

        const renderer = new TelegramRenderer(ctx, { draftStreaming } as ConstructorParameters<
          typeof TelegramRenderer
        >[1]);

        await botContextStorage.run(botCtx, () =>
          renderer.render(
            createElement(AgentReply, {
              messages,
              system: botCtx.agent.systemPrompt,
              tools: coordinatorTools,
              hiddenTools,
              model: chatConfig.model,
              maxSteps: chatConfig.maxSteps,
              guard: botConfig.guard,
              onFinish: async (result) => {
                botCtx.agent.result = result;
                for (const fn of post) {
                  try {
                    await fn(botCtx as Parameters<BotPostFn>[0]);
                  } catch (err) {
                    console.error("[nitro-bot] post-middleware error:", err);
                  }
                }
              },
            }),
          ),
        );
      } catch (err) {
        console.error("[nitro-bot] message handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("⚠️ Something went wrong handling your message.").catch(() => {});
      }
    });

    let closing = false;

    nitroApp.hooks.hook("close", async () => {
      closing = true;
      // Webhook mode: do NOT deleteWebhook here. The webhook points at the stable app URL, not this
      // machine — on a rolling deploy a departing instance would otherwise clear the webhook the new
      // instance just registered, silently killing the bot until the next boot. Polling mode: stop
      // the long-poll loop cleanly.
      if (!webhook) await bot.stop().catch(() => {});
    });

    // The bot shares this process with the host's HTTP API. Bringing the bot up must NEVER crash the
    // server — a bad token, a non-https/unreachable webhook URL, or any Telegram error would otherwise
    // take the whole API down. Log and keep serving; the webhook receiver route is mounted separately,
    // so incoming updates still work once the URL is registered.
    // Telegram occasionally returns transient errors (502/429) on startup calls. Retrying a few times
    // keeps a momentary blip from permanently disabling the bot until the next process restart.
    const withRetry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      let lastErr: unknown;
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
        await bot.api
          .setMyCommands(namedCommands.map((c) => ({ command: c.name, description: c.description })))
          .catch((err) => console.error("[nitro-bot] setMyCommands failed:", err));

      if (onStart) await onStart({ bot, info });

      if (webhook) {
        if (!/^https:\/\//i.test(webhook.url))
          throw new Error(`webhook.url must be an https URL, got "${webhook.url}".`);
        await bot.init();
        // Respond 200 to Telegram immediately, then process the update in the background. Blocking the
        // HTTP response until the (streaming, multi-second) agent finished would let Telegram time out
        // and re-deliver the same update — producing duplicate replies.
        // Idempotency by (chat, message) — NOT by update_id. Telegram can deliver the same user message
        // as two updates with different update_ids (observed in supergroups), which would otherwise drive
        // two independent agent runs and two replies. We dedupe on `${chat}:${message_id}` within a short
        // window so a repeated delivery is acked 200 but not re-processed.
        const seenMessages = new Map<string, { firstUpdateId?: number; t: number }>();
        const DEDUPE_TTL_MS = 5 * 60_000;
        const handleUpdate = async (req: Request): Promise<Response> => {
          if (webhook.secret && req.headers.get("x-telegram-bot-api-secret-token") !== webhook.secret)
            return new Response("unauthorized", { status: 401 });
          let update: Parameters<typeof bot.handleUpdate>[0];
          try {
            update = (await req.json()) as Parameters<typeof bot.handleUpdate>[0];
          } catch {
            return new Response("bad request", { status: 400 });
          }
          const msg = (update as { message?: { message_id?: number; chat?: { id?: number } } }).message;
          if (msg?.message_id !== undefined && msg.chat?.id !== undefined) {
            const key = `${msg.chat.id}:${msg.message_id}`;
            const now = Date.now();
            for (const [k, v] of seenMessages) if (now - v.t > DEDUPE_TTL_MS) seenMessages.delete(k);
            const prior = seenMessages.get(key);
            if (prior) {
              // The two deliveries' update_ids reveal whether a second bot/webhook is mirroring this chat:
              // a single bot's ids are monotonic, so wildly different ids = two delivery streams.
              console.error(
                `[nitro-bot] dropping duplicate delivery of ${key}: update ${update.update_id} (already processed as update ${prior.firstUpdateId})`,
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
        void bot
          .start()
          .then(() => {
            if (!closing) console.error("[nitro-bot] polling stopped unexpectedly.");
          })
          .catch((err) => console.error("[nitro-bot] bot.start failed:", err));
      }
    } catch (err) {
      console.error("[nitro-bot] bot startup failed — HTTP server stays up, bot disabled:", err);
    }
  });
}

function buildBotContext(ctx: Context, config: TelegramBotConfig): BotContext | null {
  const msg = ctx.message;
  if (!msg?.text || !ctx.chat || !ctx.from) return null;

  const chatType = ctx.chat.type as BotContext["thread"]["type"];
  const fallbackName = ctx.me?.first_name ?? "bot";

  const reply: ChatReply = {
    sendDocument: async (data, filename, caption) => {
      await ctx.replyWithDocument(new InputFile(data, filename), caption ? { caption } : undefined);
    },
    sendPhoto: async (data, caption) => {
      await ctx.replyWithPhoto(new InputFile(data), caption ? { caption } : undefined);
    },
    sendText: async (text) => {
      await ctx.reply(text);
    },
    react: async (emoji = "👍") => {
      // Telegram only accepts a fixed reaction set; an unsupported emoji (e.g. ✅) throws
      // REACTION_INVALID — fall back to 👍 so a "done" signal still lands.
      try {
        await ctx.react(emoji as Parameters<typeof ctx.react>[0]);
      } catch {
        if (emoji !== "👍") await ctx.react("👍").catch(() => {});
      }
    },
  };

  // In a forum supergroup every topic message carries `message_thread_id`; the "General" topic does not.
  const topicId = msg.is_topic_message ? msg.message_thread_id : undefined;
  const replyTo = msg.reply_to_message;
  const replyFrom = replyTo?.from;
  const replyToFromName = replyFrom
    ? [replyFrom.first_name, replyFrom.last_name].filter(Boolean).join(" ") || replyFrom.username
    : undefined;

  return {
    bot: { name: config.name ?? fallbackName, username: ctx.me?.username },
    message: {
      text: msg.text,
      id: msg.message_id,
      replyToId: replyTo?.message_id,
      replyToText: replyTo?.text ?? replyTo?.caption,
      replyToFromId: replyFrom ? String(replyFrom.id) : undefined,
      replyToFromName,
      repliesToBot: replyFrom ? replyFrom.id === ctx.me?.id : undefined,
    },
    user: {
      id: String(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      languageCode: ctx.from.language_code,
    },
    thread: {
      id: String(ctx.chat.id),
      type: chatType,
      title: "title" in ctx.chat ? ctx.chat.title : undefined,
      topicId,
    },
    agent: { messages: [] },
    reply,
    context: {},
  };
}
