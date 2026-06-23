import { TelegramRenderer } from "@elumixor/react-telegram";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { Bot, type Context, InputFile } from "grammy";
import { createElement } from "react";
import type { TelegramBotConfig } from "./adapters/telegram";
import { AgentReply, StaticReply } from "./agent-reply";
import { botContextStorage } from "./als";
import { type AnyBotTool, buildBotToolSet } from "./bot-tool";
import { reactBuiltin, searchHistoryBuiltin, sendFileBuiltin } from "./builtins";
import type { ToolRoute } from "./chat-handler";
import type { BotCommandDef, CommandContext } from "./command";
import { getProviderTools } from "./provider-tools";
import { registerBot } from "./registry";
import type { SubagentDefinition } from "./subagent";
import { buildCoordinatorTools, delegationGuide } from "./supervisor";
import { makeToolLabeler } from "./tool-label";
import type { BotAttachment, BotContext, BotPostFn, BotPreFn, ChatReply } from "./types";

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
  chatConfig: { model: LanguageModel; maxSteps: number; labelModel?: LanguageModel };
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
  // Passing `botInfo` lets grammy skip the `getMe` network call entirely — the bot is "initialized" at
  // construction, so it can handle updates immediately (critical on serverless cold starts).
  const bot =
    botConfig.bot ?? new Bot(botConfig.token as string, botConfig.botInfo ? { botInfo: botConfig.botInfo } : undefined);
  const registryName = options.name ?? "telegram";

  const builtins: AnyBotTool[] = [
    ...(botConfig.builtins?.sendFile === false ? [] : [sendFileBuiltin]),
    ...(botConfig.builtins?.react === false ? [] : [reactBuiltin]),
    ...(botConfig.history?.search ? [searchHistoryBuiltin(botConfig.history.search)] : []),
  ];
  const allBotTools = [...builtins, ...botTools];
  const allTools: ToolSet = { ...tools, ...buildBotToolSet(allBotTools) };

  // When a label model is configured, each tool call's `🔧` trail line is rewritten to a short
  // human-readable phrase ("Looking up Yehor") instead of the raw tool name.
  const describeTool = chatConfig.labelModel ? makeToolLabeler(chatConfig.labelModel) : undefined;

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

    // One agent turn shared by text and attachment messages: load history → run pre-middleware → run the
    // agent over [history, userMessage] → on finish, persist the turn and run post-middleware. `userText`
    // is the plain-text form stored in history (an attachment's bytes can't be persisted as a message).
    const runTurn = async (ctx: Context, botCtx: BotContext, userMessage: ModelMessage, userText: string) => {
      // So subagent (delegate) tool calls can label their nested `↳ 🔧` trail lines too (see supervisor).
      botCtx.agent.describeTool = describeTool;
      if (botConfig.history?.load) {
        try {
          botCtx.agent.messages = await botConfig.history.load(botCtx);
        } catch (err) {
          console.error("[nitro-bot] history.load error:", err instanceof Error ? err.stack : err);
        }
      }

      for (const fn of pre) {
        if ((await fn(botCtx)) === false) return;
      }

      // With subagents declared, teach the coordinator to delegate (appended after middleware sets the base prompt).
      if (subagents.length > 0) {
        const guide = delegationGuide(subagents);
        botCtx.agent.systemPrompt = botCtx.agent.systemPrompt ? `${botCtx.agent.systemPrompt}\n\n${guide}` : guide;
      }

      const messages: ModelMessage[] = [...botCtx.agent.messages, userMessage];

      const renderer = new TelegramRenderer(ctx, { draftStreaming } as ConstructorParameters<
        typeof TelegramRenderer
      >[1]);

      await botContextStorage.run(botCtx, () =>
        renderer.render(
          createElement(AgentReply, {
            messages,
            system: botCtx.agent.systemPrompt,
            // Provider-/gateway-executed tools (e.g. web search) are registered at startup and merged in
            // per turn, so they reach the coordinator regardless of registration vs. setup ordering.
            tools: { ...coordinatorTools, ...getProviderTools() },
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
                  await fn(botCtx as Parameters<BotPostFn>[0]);
                } catch (err) {
                  console.error("[nitro-bot] post-middleware error:", err);
                }
              }
            },
          }),
        ),
      );
    };

    bot.on("message:text", async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        // Slash commands are handled above — don't also route them through the agent.
        if (botCtx.message.text.startsWith("/")) return;
        await runTurn(ctx, botCtx, { role: "user", content: botCtx.message.text }, botCtx.message.text);
      } catch (err) {
        console.error("[nitro-bot] message handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("⚠️ Something went wrong handling your message.").catch(() => {});
      }
    });

    // Documents and photos go to the agent, not a hardcoded pipeline: download the file, attach it to the
    // context (so a tool can read its bytes via `ctx.message.attachment`), AND hand it to the model as a
    // multimodal part so it can see the file, classify it, and pick the right tool. The caption is the prompt.
    bot.on(["message:document", "message:photo"], async (ctx) => {
      try {
        const botCtx = buildBotContext(ctx, botConfig);
        if (!botCtx) return;
        const attachment = await downloadAttachment(ctx, bot.token);
        if (!attachment) return;
        botCtx.message.attachment = attachment;

        const caption = (ctx.message?.caption ?? "").trim();
        const userMessage: ModelMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text:
                caption || `(The user sent a ${attachment.kind}: ${attachment.filename}. Decide what to do with it.)`,
            },
            { type: "file", data: attachment.bytes, mediaType: attachment.mediaType, filename: attachment.filename },
          ],
        };
        const label = `[${attachment.kind} ${attachment.filename}]`;
        await runTurn(ctx, botCtx, userMessage, caption ? `${label} ${caption}` : label);
      } catch (err) {
        console.error("[nitro-bot] attachment handler error:", err instanceof Error ? err.stack : err);
        await ctx.reply("⚠️ Something went wrong handling your file.").catch(() => {});
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

    // The webhook receiver: validates the secret, dedupes, hands the update to grammy. Pure — needs no
    // network — so it can be registered the instant the bot is initialized.
    const buildWebhookHandler = (hook: NonNullable<typeof webhook>) => {
      // Idempotency by (chat, message) — NOT by update_id. Telegram can deliver the same user message
      // as two updates with different update_ids (observed in supergroups), which would otherwise drive
      // two independent agent runs and two replies. We dedupe on `${chat}:${message_id}` within a short
      // window so a repeated delivery is acked 200 but not re-processed.
      const seenMessages = new Map<string, { firstUpdateId?: number; t: number }>();
      const DEDUPE_TTL_MS = 5 * 60_000;
      return async (req: Request): Promise<Response> => {
        if (hook.secret && req.headers.get("x-telegram-bot-api-secret-token") !== hook.secret)
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
            console.error(
              `[nitro-bot] dropping duplicate delivery of ${key}: update ${update.update_id} (already processed as update ${prior.firstUpdateId})`,
            );
            return new Response(null, { status: 200 });
          }
          seenMessages.set(key, { firstUpdateId: update.update_id, t: now });
        }
        // On serverless the instance freezes once we respond, so a backgrounded agent turn is killed
        // mid-reply. `awaitProcessing` blocks the 200 until the turn (and its streamed reply) finishes.
        const processing = bot
          .handleUpdate(update)
          .catch((err) => console.error("[nitro-bot] handleUpdate error:", err));
        if (hook.awaitProcessing) await processing;
        return new Response(null, { status: 200 });
      };
    };

    // Register the receiver as early as possible. When the bot is already initialized — i.e. `botInfo` was
    // supplied (recommended on serverless) or a pre-inited `bot` was passed — it can handle updates with no
    // network at all, so we register here, BEFORE the flaky `getMe`/`setWebhook` below. That way a cold
    // serverless instance answers Telegram with 200 on its very first request instead of 503-until-warm.
    let webhookRegistered = false;
    if (webhook && bot.isInited()) {
      if (!/^https:\/\//i.test(webhook.url))
        console.error(`[nitro-bot] webhook.url must be https, got "${webhook.url}" — receiver not registered.`);
      else {
        registerBot(registryName, { bot, handleUpdate: buildWebhookHandler(webhook) });
        webhookRegistered = true;
      }
    }

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
      // When already initialized (botInfo supplied), use it — no network. Otherwise fetch it, with retries.
      const me = bot.isInited() ? bot.botInfo : await withRetry("getMe", () => bot.api.getMe());
      const info = { id: me.id, username: me.username, name: botConfig.name ?? me.first_name };

      if (namedCommands.length > 0)
        await bot.api
          .setMyCommands(namedCommands.map((c) => ({ command: c.name, description: c.description })))
          .catch((err) => console.error("[nitro-bot] setMyCommands failed:", err));

      if (onStart) await onStart({ bot, info });

      if (webhook) {
        if (!/^https:\/\//i.test(webhook.url))
          throw new Error(`webhook.url must be an https URL, got "${webhook.url}".`);
        // Not already registered early (no botInfo / not pre-inited) — init now and register. `bot.init()`
        // is a no-op when botInfo was supplied.
        if (!webhookRegistered) {
          await bot.init();
          registerBot(registryName, { bot, handleUpdate: buildWebhookHandler(webhook) });
          webhookRegistered = true;
        }
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
  // Text, document, and photo messages all reach here; only the bare envelope (chat + sender) is required.
  if (!msg || !ctx.chat || !ctx.from) return null;

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
      text: msg.text ?? msg.caption ?? "",
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

/** Download the document or largest photo on the current message from Telegram. Returns null if absent. */
async function downloadAttachment(ctx: Context, token: string): Promise<BotAttachment | null> {
  const doc = ctx.message?.document;
  const photo = ctx.message?.photo?.at(-1);

  let fileId: string;
  let mediaType: string;
  let filename: string;
  let kind: "document" | "photo";
  if (doc) {
    fileId = doc.file_id;
    mediaType = doc.mime_type ?? "application/octet-stream";
    filename = doc.file_name ?? "document";
    kind = "document";
  } else if (photo) {
    // Photos carry no name/mime; Telegram always serves them as JPEG.
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
