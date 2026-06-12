import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { generateText, stepCountIs, streamText, tool, asSchema } from 'ai';
import { defineEventHandler, getValidatedQuery, readFormData, readValidatedBody, readBody, createError, setResponseHeader } from 'h3';
import { AsyncLocalStorage } from 'node:async_hooks';

async function runAgent(options) {
  const result = await generateText({
    model: options.model,
    system: options.systemPrompt,
    prompt: options.prompt,
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? 8)
  });
  return { text: result.text, steps: result.steps?.length ?? 0 };
}
async function runAgentStream(options) {
  const { messages, prompt, onDelta, onToolCall } = options;
  const result = streamText({
    model: options.model,
    system: options.systemPrompt,
    ...messages && messages.length > 0 ? { messages } : { prompt: prompt ?? "" },
    tools: options.tools,
    stopWhen: stepCountIs(options.maxSteps ?? 8)
  });
  let text = "";
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta": {
        const delta = part.text ?? part.textDelta;
        if (delta) {
          text += delta;
          onDelta?.(delta);
        }
        break;
      }
      case "tool-call":
        onToolCall?.(part.toolName);
        break;
      case "error":
        throw part.error;
    }
  }
  const steps = (await result.steps).length;
  return { text: text || await result.text, steps };
}

const botContextStorage = new AsyncLocalStorage();
function getBotContext() {
  return botContextStorage.getStore();
}

const noopReply$1 = {
  sendDocument: async () => {
  },
  sendPhoto: async () => {
  },
  sendText: async () => {
  },
  react: async () => {
  }
};
function buildWebBotContext(opts) {
  if (!opts.conversationId && !opts.user && !opts.context) return void 0;
  return {
    bot: { name: "web" },
    message: { text: "", id: 0 },
    user: {
      id: opts.user?.id ?? "",
      username: opts.user?.username,
      firstName: opts.user?.firstName,
      lastName: opts.user?.lastName
    },
    thread: { id: opts.conversationId ?? "", type: "private" },
    agent: { messages: opts.messages ?? [], systemPrompt: opts.systemPrompt },
    reply: noopReply$1,
    context: opts.context ?? {}
  };
}
async function* runAgentEventStream(opts) {
  const botCtx = buildWebBotContext(opts);
  const queue = [];
  let notify = null;
  const wake = () => {
    notify?.();
    notify = null;
  };
  const push = (event) => {
    queue.push(event);
    wake();
  };
  let done = false;
  let error;
  let result;
  const exec = () => runAgentStream({
    tools: opts.tools,
    model: opts.model,
    maxSteps: opts.maxSteps,
    systemPrompt: opts.systemPrompt,
    messages: opts.messages,
    prompt: opts.prompt,
    onDelta: (text) => push({ type: "delta", text }),
    onToolCall: (name) => push({ type: "tool", name })
  });
  const runner = (botCtx ? botContextStorage.run(botCtx, exec) : exec()).then((r) => {
    result = r;
  }).catch((e) => {
    error = e;
  }).finally(() => {
    done = true;
    wake();
  });
  let i = 0;
  while (true) {
    while (i < queue.length) {
      const event = queue[i++];
      if (event) yield event;
    }
    if (done) break;
    await new Promise((resolve) => {
      notify = resolve;
    });
  }
  await runner;
  if (error) throw error;
  return result ?? { text: "", steps: 0 };
}

const BOT_TOOL_BRAND = Symbol.for("nitro-bot.bot-tool");
function botTool(def) {
  return {
    [BOT_TOOL_BRAND]: true,
    name: def.name,
    description: def.description,
    input: def.input ?? {},
    hidden: def.hidden,
    subagent: def.subagent,
    execute: def.execute
  };
}
function isBotToolDefinition(value) {
  return typeof value === "object" && value !== null && value[BOT_TOOL_BRAND] === true;
}
function buildBotToolSet(defs) {
  const entries = defs.map((def) => {
    return [
      def.name,
      tool({
        description: def.description,
        inputSchema: z.object(def.input),
        execute: async (input) => {
          const ctx = getBotContext();
          if (!ctx) throw new Error(`[nitro-bot] bot tool "${def.name}" was called outside an active bot turn.`);
          return await def.execute(input, ctx);
        }
      })
    ];
  });
  return Object.fromEntries(entries);
}

const sendFileBuiltin = botTool({
  name: "send_file",
  description: "Send a file from disk to the current chat. Use type 'photo' for images (compressed preview), 'document' for everything else. Call this after a tool returns a file path you want the user to receive.",
  input: {
    path: z.string().describe("Path to the file on disk (e.g. a path returned by another tool)."),
    filename: z.string().nullable().describe("Display name, or null to use the file's own name."),
    type: z.enum(["document", "photo"]).describe("'photo' for images, 'document' otherwise.")
  },
  execute: async ({ path, filename, type }, ctx) => {
    const data = await readFile(path);
    const name = filename ?? basename(path);
    if (type === "photo") await ctx.reply.sendPhoto(data, name);
    else await ctx.reply.sendDocument(data, name);
    return `Sent ${name} to the chat.`;
  }
});
const reactBuiltin = botTool({
  name: "react",
  // Reacting is an acknowledgement, not an action worth narrating — keep it out of the tool trail.
  hidden: true,
  description: "React to the user's current message with an emoji (e.g. to acknowledge it's handled) instead of sending text. Telegram allows only a fixed set: \u{1F44D} \u{1F44E} \u2764 \u{1F525} \u{1F389} \u{1F64F} \u{1F44C} \u{1F4AF} \u{1F3C6} (\u2705 is NOT allowed and becomes \u{1F44D}). Defaults to \u{1F44D}.",
  input: { emoji: z.string().nullable().describe("Reaction emoji from Telegram's allowed set, or null for \u{1F44D}.") },
  execute: async ({ emoji }, ctx) => {
    await ctx.reply.react(emoji ?? "\u{1F44D}");
    return `Reacted with ${emoji ?? "\u{1F44D}"}.`;
  }
});
function searchHistoryBuiltin(search) {
  return botTool({
    name: "search_history",
    description: "Search earlier messages in THIS conversation for context beyond the few most recent turns. Pass a query of keywords to filter (omit to get the most recent messages). Use this to recall what the user said or what you did before, rather than guessing.",
    input: {
      query: z.string().nullable().describe("Keywords to match against message text, or null for the most recent."),
      limit: z.number().int().min(1).max(100).nullable().describe("Max messages to return (default 20).")
    },
    execute: async ({ query, limit }, ctx) => {
      const hits = await search({ query: query ?? void 0, limit: limit ?? 20 }, ctx);
      return hits.length ? hits : "No earlier messages matched.";
    }
  });
}

function buildToolSet(routes, invoke) {
  const entries = routes.map((route) => {
    const { definition } = route.module;
    const base = Object.keys(definition.input).length > 0 ? definition.input : route.autoInput ?? definition.input;
    const inputShape = route.paramsInput ? { ...route.paramsInput, ...base } : base;
    const inputSchema = z.object(llmSafeShape(inputShape));
    assertRepresentable(definition.name, inputSchema);
    return [
      definition.name,
      tool({
        description: definition.description,
        inputSchema,
        execute: async (input) => invoke(route, input)
      })
    ];
  });
  return Object.fromEntries(entries);
}
function assertRepresentable(toolName, schema) {
  try {
    asSchema(schema).jsonSchema;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[nitro-bot] Tool "${toolName}" has an input schema that cannot be represented in JSON Schema: ${message}. Replace the offending field with a JSON-representable type (e.g. an ISO date string that parses to a Date via \`z.string().transform((v) => new Date(v)).pipe(z.date())\`).`
    );
  }
}
function llmSafeShape(shape) {
  const out = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = llmSafe(schema);
  return out;
}
function defType(schema) {
  return schema._zod?.def?.type;
}
function defOf(schema) {
  return schema._zod?.def ?? {};
}
function withDescription(schema, source) {
  const description = source.description;
  return description ? schema.describe(description) : schema;
}
function llmSafe(schema) {
  switch (defType(schema)) {
    case "date":
      return withDescription(
        z.string().transform((value) => new Date(value)).pipe(z.date()),
        schema
      );
    case "optional": {
      const inner = defOf(schema).innerType;
      return inner ? withDescription(llmSafe(inner).nullable(), schema) : schema;
    }
    case "nullable": {
      const inner = defOf(schema).innerType;
      return inner ? withDescription(llmSafe(inner).nullable(), schema) : schema;
    }
    case "array": {
      const element = defOf(schema).element;
      return element ? withDescription(z.array(llmSafe(element)), schema) : schema;
    }
    case "object": {
      const shape = defOf(schema).shape;
      if (!shape) return schema;
      return withDescription(z.object(llmSafeShape(shape)), schema);
    }
    default:
      return schema;
  }
}
function createChatHandler(options) {
  const invoke = options.invoke ?? defaultInvoke;
  const model = options.model ?? "anthropic/claude-sonnet-4.6";
  const maxSteps = options.maxSteps ?? 8;
  const system = options.systemPrompt;
  const source = options.source ?? "json";
  const field = options.field ?? "message";
  const tools = buildToolSet(options.tools, invoke);
  return defineEventHandler(async (event) => {
    const prompt = await readPrompt(event, source, field);
    const result = await runAgent({ prompt, tools, model, systemPrompt: system, maxSteps });
    const response = { text: result.text, steps: result.steps };
    return response;
  });
}
async function readPrompt(event, source, field) {
  if (source === "query") {
    const schema2 = z.object({ [field]: z.string() });
    const data2 = await getValidatedQuery(event, (raw) => schema2.parse(raw));
    return data2[field];
  }
  if (source === "form") {
    const form = await readFormData(event);
    const value = form.get(field);
    if (typeof value !== "string" || value.length === 0)
      throw Object.assign(new Error(`Form field '${field}' is required.`), { statusCode: 400 });
    return value;
  }
  const schema = z.object({ [field]: z.string() });
  const data = await readValidatedBody(event, (raw) => schema.parse(raw));
  return data[field];
}
async function defaultInvoke(route, input) {
  const handler = route.module.default;
  const useQuery = route.method === "GET" || route.method === "DELETE";
  const { params, rest } = splitParams(input, route.params);
  if (handler && typeof handler.execute === "function") {
    const event = createSyntheticEvent(route.method, { params });
    return await handler.execute(event, useQuery ? void 0 : rest, useQuery ? rest : void 0);
  }
  if (handler) {
    const event = createSyntheticEvent(route.method, useQuery ? { params, query: rest } : { params, body: rest });
    return await handler(event);
  }
  const fetcher = globalThis.$fetch;
  if (!fetcher) {
    throw new Error(
      `[nitro-bot] route ${route.path} has no default handler and \`$fetch\` is unavailable. Pass a custom \`invoke\` to createChatHandler.`
    );
  }
  return fetcher(substituteParams(route.path, params), {
    method: route.method,
    ...useQuery ? { query: rest } : { body: rest }
  });
}
function splitParams(input, paramNames) {
  if (!paramNames?.length || !input || typeof input !== "object") return { params: {}, rest: input };
  const params = {};
  const rest = {};
  for (const [key, value] of Object.entries(input)) {
    if (paramNames.includes(key)) {
      if (value !== void 0 && value !== null) params[key] = String(value);
    } else rest[key] = value;
  }
  return { params, rest };
}
function substituteParams(path, params) {
  return path.replace(/:(\w+)/g, (whole, name) => {
    const value = params[name];
    return value === void 0 ? whole : encodeURIComponent(value);
  });
}
function encodeQuery(query) {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === void 0 || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
function createSyntheticEvent(method = "POST", payload) {
  const noop = () => {
  };
  const ctx = getBotContext();
  const baseContext = {};
  if (payload?.params && Object.keys(payload.params).length > 0) baseContext.params = payload.params;
  if (ctx) {
    baseContext.bot = {
      threadId: ctx.thread.id,
      threadName: ctx.thread.title,
      threadType: ctx.thread.type,
      userId: ctx.user.id,
      userName: ctx.user.username ?? ctx.user.firstName,
      botName: ctx.bot.name,
      botUsername: ctx.bot.username,
      messageId: ctx.message.id,
      replyToId: ctx.message.replyToId
    };
    Object.assign(baseContext, ctx.context);
  }
  const path = `/${encodeQuery(payload?.query)}`;
  const hasBody = !!payload && "body" in payload && payload.body !== void 0;
  const headers = hasBody ? { "content-type": "application/json" } : {};
  const req = { headers, method, url: path, on: noop };
  const res = {
    on: noop,
    once: noop,
    end: noop,
    setHeader: noop,
    getHeader: () => void 0,
    statusCode: 200,
    headersSent: false
  };
  return {
    node: { req, res },
    context: baseContext,
    path,
    _path: path,
    // readRawBody() consumes `_requestBody` first; a plain object is JSON-stringified by h3.
    _requestBody: hasBody ? payload?.body : void 0,
    method,
    headers: new Headers(headers),
    web: { request: new Request(`http://localhost${path}`) }
  };
}

const registry = /* @__PURE__ */ new Map();
function registerBot(name, entry) {
  registry.set(name, entry);
}
function getBot(name) {
  if (name) return registry.get(name);
  return registry.values().next().value;
}

const noopReply = {
  sendDocument: async () => {
  },
  sendPhoto: async () => {
  },
  sendText: async () => {
  },
  react: async () => {
  }
};
function buildSessionContext(message, resolved, messages) {
  return {
    bot: { name: "web" },
    message: { text: message, id: 0 },
    user: {
      id: resolved.user?.id ?? "",
      username: resolved.user?.username,
      firstName: resolved.user?.firstName,
      lastName: resolved.user?.lastName
    },
    thread: { id: resolved.conversationId, type: "private" },
    agent: { messages, systemPrompt: resolved.systemPrompt },
    reply: noopReply,
    context: resolved.context ?? {}
  };
}
function createSessionChatHandler(options) {
  const field = options.field ?? "message";
  const stream = options.stream ?? false;
  const toolSet = buildToolSet(options.tools, defaultInvoke);
  return defineEventHandler(async (event) => {
    const body = await readBody(event) ?? {};
    const message = body[field];
    if (typeof message !== "string" || message.trim().length === 0)
      throw createError({ statusCode: 400, statusMessage: `Field '${field}' is required.` });
    const resolved = await options.session.resolve(event, body);
    const history = await options.session.loadHistory?.(resolved, event) ?? [];
    const messages = [...history];
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || last.content !== message) messages.push({ role: "user", content: message });
    const botCtx = buildSessionContext(message, resolved, messages);
    const run = (onDelta, onToolCall) => botContextStorage.run(
      botCtx,
      () => runAgentStream({
        messages,
        tools: toolSet,
        model: options.model,
        systemPrompt: resolved.systemPrompt,
        maxSteps: options.maxSteps,
        onDelta,
        onToolCall
      })
    );
    if (!stream) {
      const result = await run();
      await persist(options.session, resolved, message, result.text, event);
      return { text: result.text, steps: result.steps };
    }
    setResponseHeader(event, "Content-Type", "text/event-stream");
    setResponseHeader(event, "Cache-Control", "no-cache, no-transform");
    setResponseHeader(event, "Connection", "keep-alive");
    setResponseHeader(event, "X-Accel-Buffering", "no");
    const encoder = new TextEncoder();
    const send = (controller, data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}

`));
    return new ReadableStream({
      async start(controller) {
        try {
          const result = await run(
            (delta) => send(controller, { delta }),
            (name) => send(controller, { tool: name })
          );
          await persist(options.session, resolved, message, result.text, event);
          send(controller, { done: true, steps: result.steps });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          send(controller, { error: errorMessage });
        } finally {
          controller.close();
        }
      }
    });
  });
}
async function persist(session, resolved, user, assistant, event) {
  if (!session.save) return;
  try {
    await session.save(resolved, { user, assistant }, event);
  } catch (error) {
    console.error("[nitro-bot] chat session save failed:", error);
  }
}

export { botTool as a, botContextStorage as b, buildBotToolSet as c, buildToolSet as d, createChatHandler as e, createSessionChatHandler as f, defaultInvoke as g, getBot as h, getBotContext as i, isBotToolDefinition as j, registerBot as k, runAgent as l, runAgentEventStream as m, runAgentStream as n, sendFileBuiltin as o, reactBuiltin as r, searchHistoryBuiltin as s };
