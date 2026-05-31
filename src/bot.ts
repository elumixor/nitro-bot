import { TelegramRenderer } from "@elumixor/react-telegram";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { Context } from "grammy";
import { createElement } from "react";
import type { TelegramBotConfig } from "./adapters/telegram";
import { AgentReply } from "./agent-reply";
import { botContextStorage } from "./als";
import type { BotContext, BotPostFn, BotPreFn } from "./types";

type NitroApp = { hooks: { hook(name: "close", fn: () => unknown): void } };
const defineNitroPlugin = <T extends (app: NitroApp) => unknown | Promise<unknown>>(fn: T): T => fn;

export type StartTelegramBotOptions = {
  botConfig: TelegramBotConfig;
  pre: BotPreFn[];
  post: BotPostFn[];
  tools: ToolSet;
  chatConfig: { model: LanguageModel; maxSteps: number };
};

export function startTelegramBot(options: StartTelegramBotOptions) {
  const { botConfig, pre, post, tools, chatConfig } = options;
  const { bot, draftStreaming = true } = botConfig;

  return defineNitroPlugin((nitroApp) => {
    bot.on("message:text", async (ctx) => {
      const botCtx = buildBotContext(ctx, botConfig);
      if (!botCtx) return;

      for (const fn of pre) {
        const result = await fn(botCtx);
        if (result === false) return;
      }

      // Append the current user message if no pre-middleware already did.
      const messages: ModelMessage[] = [...botCtx.agent.messages];
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user" || last.content !== botCtx.message.text) {
        messages.push({ role: "user", content: botCtx.message.text });
      }

      // react-telegram's TelegramRenderer reads `draftStreaming` off the options bag but
      // declares the parameter as the base RendererOptions; cast to satisfy strict TS.
      const renderer = new TelegramRenderer(ctx, { draftStreaming } as ConstructorParameters<
        typeof TelegramRenderer
      >[1]);

      // Carry the bot context through any tool invocations on this turn. Tools read it
      // via `event.context.*` (see generated bot-context middleware) or `getBotContext()`.
      await botContextStorage.run(botCtx, () =>
        renderer.render(
          createElement(AgentReply, {
            messages,
            tools,
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
    });

    void bot.start();
    nitroApp.hooks.hook("close", () => bot.stop());
  });
}

function buildBotContext(ctx: Context, config: TelegramBotConfig): BotContext | null {
  const msg = ctx.message;
  if (!msg?.text || !ctx.chat || !ctx.from) return null;

  const chatType = ctx.chat.type as BotContext["thread"]["type"];
  const fallbackName = ctx.me?.first_name ?? "bot";

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
    context: {},
  };
}
