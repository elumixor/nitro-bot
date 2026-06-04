import * as react_jsx_runtime from 'react/jsx-runtime';
import { ModelMessage, ToolSet, LanguageModel } from 'ai';
import { T as TelegramBotConfig, d as BotPreFn, c as BotPostFn, A as AnyBotTool, B as BotCommandDef } from './shared/nitro-bot.BfHVS9wy.js';
export { b as BotEntry, j as botContextStorage, p as getBot, q as getBotContext, s as registerBot } from './shared/nitro-bot.BfHVS9wy.js';
import 'grammy';
import 'node:async_hooks';
import 'zod';

type AgentReplyProps = {
    messages: ModelMessage[];
    /** System prompt (preferred over `role: "system"` messages). Set via `ctx.agent.systemPrompt`. */
    system?: string;
    tools: ToolSet;
    model: LanguageModel;
    maxSteps?: number;
    /** Called when the stream finishes — passes the final text + step count back so callers can run post-middleware. */
    onFinish?: (result: {
        text: string;
        steps: number;
    }) => void | Promise<void>;
};
declare function AgentReply({ messages, system, tools, model, maxSteps, onFinish }: AgentReplyProps): react_jsx_runtime.JSX.Element;

type NitroApp = {
    hooks: {
        hook(name: "close", fn: () => unknown): void;
    };
};
type StartTelegramBotOptions = {
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
    chatConfig: {
        model: LanguageModel;
        maxSteps: number;
    };
};
declare function startTelegramBot(options: StartTelegramBotOptions): (nitroApp: NitroApp) => Promise<void>;

export { AgentReply, startTelegramBot };
export type { AgentReplyProps, StartTelegramBotOptions };
