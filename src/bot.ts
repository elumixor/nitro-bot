import { TelegramRenderer } from "@elumixor/react-telegram";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { Bot, type Context, InputFile, webhookCallback } from "grammy";
import { createElement } from "react";
import type { TelegramBotConfig } from "./adapters/telegram";
import { AgentReply, StaticReply } from "./agent-reply";
import { botContextStorage } from "./als";
import { type AnyBotTool, buildBotToolSet } from "./bot-tool";
import { sendFileBuiltin } from "./builtins";
import type { BotCommandDef, CommandContext } from "./command";
import { registerBot } from "./registry";
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
  /** Slash commands discovered under `src/bots/<name>/commands` — run directly, bypassing the agent. */
  commands?: BotCommandDef[];
  /** Registry key — the bot folder name (e.g. "telegram"). Used by getBot() and the webhook route. */
  name?: string;
  chatConfig: { model: LanguageModel; maxSteps: number };
};

export function startTelegramBot(options: StartTelegramBotOptions) {
  const { botConfig, pre, post, tools, botTools = [], commands = [], chatConfig } = options;
  const { draftStreaming = true, webhook, onStart } = botConfig;
  if (!botConfig.bot && !botConfig.token)
    throw new Error("[nitro-bot] defineTelegramBot requires either `token` or `bot`.");
  const bot = botConfig.bot ?? new Bot(botConfig.token as string);
  const registryName = options.name ?? "telegram";

  const builtins = botConfig.builtins?.sendFile === false ? [] : [sendFileBuiltin];
  const allTools: ToolSet = { ...tools, ...buildBotToolSet([...builtins, ...botTools]) };

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
                return t.execute(input ?? {}, { toolCallId: `command:${cmd.name}`, messages: [] });
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
              tools: allTools,
              model: chatConfig.model,
              maxSteps: chatConfig.maxSteps,
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
      if (webhook) await bot.api.deleteWebhook().catch(() => {});
      else await bot.stop().catch(() => {});
    });

    // The bot shares this process with the host's HTTP API. Bringing the bot up must NEVER crash the
    // server — a bad token, a non-https/unreachable webhook URL, or any Telegram error would otherwise
    // take the whole API down. Log and keep serving; the webhook receiver route is mounted separately,
    // so incoming updates still work once the URL is registered.
    try {
      const me = await bot.api.getMe();
      const info = { id: me.id, username: me.username, name: botConfig.name ?? me.first_name };

      if (namedCommands.length > 0)
        await bot.api
          .setMyCommands(namedCommands.map((c) => ({ command: c.name, description: c.description })))
          .catch((err) => console.error("[nitro-bot] setMyCommands failed:", err));

      if (onStart) await onStart({ bot, info });

      if (webhook) {
        if (!/^https:\/\//i.test(webhook.url))
          throw new Error(`webhook.url must be an https URL, got "${webhook.url}".`);
        const handleUpdate = webhookCallback(bot, "std/http", { secretToken: webhook.secret });
        await bot.init();
        registerBot(registryName, { bot, handleUpdate });
        await bot.api.setWebhook(webhook.url, { secret_token: webhook.secret });
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
  };

  return {
    bot: { name: config.name ?? fallbackName, username: ctx.me?.username },
    message: {
      text: msg.text,
      id: msg.message_id,
      replyToId: msg.reply_to_message?.message_id,
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
    },
    agent: { messages: [] },
    reply,
    context: {},
  };
}
