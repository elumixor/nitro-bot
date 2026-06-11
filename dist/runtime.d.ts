import { O as OutputGuard, T as TelegramBotConfig, f as BotPreFn, e as BotPostFn, b as AnyBotTool, x as ToolRoute, B as BotCommandDef, s as SubagentDefinition } from './shared/nitro-bot.Bf--YHj6.js';
export { A as AgentEvent, a as AgentEventStreamOptions, d as BotEntry, q as RunAgentResult, S as SessionChatOptions, r as StreamAgentOptions, z as botContextStorage, L as createSessionChatHandler, V as getBot, W as getBotContext, _ as registerBot, a1 as runAgentEventStream, a2 as runAgentStream } from './shared/nitro-bot.Bf--YHj6.js';
import * as react_jsx_runtime from 'react/jsx-runtime';
import { ModelMessage, ToolSet, LanguageModel } from 'ai';
import 'grammy';
import 'node:async_hooks';
import 'zod';
import 'h3';

type AgentReplyProps = {
    messages: ModelMessage[];
    /** System prompt (preferred over `role: "system"` messages). Set via `ctx.agent.systemPrompt`. */
    system?: string;
    tools: ToolSet;
    /** Tool names whose calls are not shown in the `🔧 <name>` trail (e.g. `react`). */
    hiddenTools?: readonly string[];
    model: LanguageModel;
    maxSteps?: number;
    /** Called when the stream finishes — passes the final text + step count back so callers can run post-middleware. */
    onFinish?: (result: {
        text: string;
        steps: number;
    }) => void | Promise<void>;
    /** Streaming output guard. When active for this chat, completed chunks are scrubbed before being sent. */
    guard?: OutputGuard;
};
declare function AgentReply({ messages, system, tools, hiddenTools, model, maxSteps, onFinish, guard, }: AgentReplyProps): react_jsx_runtime.JSX.Element;

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
    /** Route tool metadata — only consulted for per-tool flags like `hidden` (the runnable set is `tools`). */
    toolRoutes?: ToolRoute[];
    /** Slash commands discovered under `src/bots/<name>/commands` — run directly, bypassing the agent. */
    commands?: BotCommandDef[];
    /** Subagents discovered under `src/bots/<name>/subagents` — tools tagged `subagent: "<name>"` route to these. */
    subagents?: SubagentDefinition[];
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
