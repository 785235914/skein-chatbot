import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ChatRequestSchema,
  ChatResponseSchema,
  MessageViewSchema,
  ResetSessionResponseSchema,
  AbortSessionResponseSchema,
  RuntimeEventSchema,
  SessionViewSchema,
  encodeSseEvent,
  type ChatRequest,
  type PublicError,
  type RuntimeEvent,
} from "@skein-chatbot/contracts";
import { RuntimeError, RuntimeErrorCode } from "@skein-chatbot/core";

import type { ApiChatInput, ApiRuntime } from "./api-runtime.js";
import {
  createPublicError,
  mapPublicError,
  sendPublicError,
} from "./public-errors.js";
import { createRequestAbortContext } from "./request-abort.js";

const DEFAULT_USER = { userId: "demo-user" } as const;

const SessionParamsSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
  })
  .strict();

const MessagesResponseSchema = z
  .object({ messages: z.array(MessageViewSchema) })
  .strict();

const traceIdFor = (request: FastifyRequest): string => String(request.id);

const toRuntimeInput = (input: ChatRequest): ApiChatInput => ({
  message: input.message,
  user: DEFAULT_USER,
  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  ...(input.mode === undefined ? {} : { mode: input.mode }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

const parseChatRequest = (
  request: FastifyRequest,
  reply: FastifyReply,
): ChatRequest | null => {
  const parsed = ChatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    sendPublicError(
      reply,
      createPublicError(RuntimeErrorCode.VALIDATION_ERROR, traceIdFor(request)),
    );
    return null;
  }
  return parsed.data;
};

const parseSessionId = (
  request: FastifyRequest,
  reply: FastifyReply,
): string | null => {
  const parsed = SessionParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendPublicError(
      reply,
      createPublicError(RuntimeErrorCode.VALIDATION_ERROR, traceIdFor(request)),
    );
    return null;
  }
  return parsed.data.sessionId;
};

const assertRuntimeOutput = <Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeError(
      RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      "Runtime output did not match the public contract.",
    );
  }
  return parsed.data;
};

const sendStreamFailure = (
  reply: FastifyReply,
  error: unknown,
  traceId: string,
): void => {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return;
  }
  const mapped = mapPublicError(error, traceId);
  const event: RuntimeEvent = { type: "turn.failed", error: mapped.body };
  reply.raw.write(encodeSseEvent(event));
};

const openEventStream = (reply: FastifyReply): void => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  reply.raw.flushHeaders();
};

const streamChat = async (
  runtime: ApiRuntime,
  input: ChatRequest,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const requestAbort = createRequestAbortContext(request, reply);
  const traceId = traceIdFor(request);
  let terminalEventSent = false;

  openEventStream(reply);

  try {
    for await (const candidate of runtime.stream(
      toRuntimeInput(input),
      requestAbort.signal,
    )) {
      if (terminalEventSent || reply.raw.destroyed || reply.raw.writableEnded) {
        break;
      }

      const event = assertRuntimeOutput(RuntimeEventSchema, candidate);
      reply.raw.write(encodeSseEvent(event));
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        terminalEventSent = true;
        break;
      }
    }

    if (!terminalEventSent && !requestAbort.signal.aborted) {
      sendStreamFailure(
        reply,
        new RuntimeError(
          RuntimeErrorCode.ORCHESTRATION_FAILED,
          "Runtime stream ended before a terminal event.",
        ),
        traceId,
      );
    }
  } catch (error) {
    if (!terminalEventSent) {
      sendStreamFailure(reply, error, traceId);
    }
  } finally {
    requestAbort.dispose();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }
  }

  return reply;
};

export const registerPublicRoutes = (
  app: FastifyInstance,
  runtime: ApiRuntime,
): void => {
  app.post("/api/v1/chat", async (request, reply) => {
    const input = parseChatRequest(request, reply);
    if (input === null) {
      return reply;
    }

    const requestAbort = createRequestAbortContext(request, reply);
    try {
      const response = await runtime.chat(
        toRuntimeInput(input),
        requestAbort.signal,
      );
      return assertRuntimeOutput(ChatResponseSchema, response);
    } finally {
      requestAbort.dispose();
    }
  });

  app.post("/api/v1/chat/stream", async (request, reply) => {
    const input = parseChatRequest(request, reply);
    if (input === null) {
      return reply;
    }
    return streamChat(runtime, input, request, reply);
  });

  app.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) {
      return reply;
    }
    const session = await runtime.getSession(sessionId);
    return assertRuntimeOutput(SessionViewSchema, session);
  });

  app.get("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) {
      return reply;
    }
    const messages = await runtime.getMessages(sessionId);
    return assertRuntimeOutput(MessagesResponseSchema, { messages });
  });

  app.post("/api/v1/sessions/:sessionId/reset", async (request, reply) => {
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) {
      return reply;
    }
    const response = await runtime.resetSession(sessionId);
    return assertRuntimeOutput(ResetSessionResponseSchema, response);
  });

  app.post("/api/v1/sessions/:sessionId/abort", async (request, reply) => {
    const sessionId = parseSessionId(request, reply);
    if (sessionId === null) {
      return reply;
    }
    const response = await runtime.abortSession(sessionId);
    return assertRuntimeOutput(AbortSessionResponseSchema, response);
  });

  app.setNotFoundHandler((request, reply) => {
    const response = createPublicError(
      RuntimeErrorCode.SESSION_NOT_FOUND,
      traceIdFor(request),
    );
    return sendPublicError(reply, response);
  });
};

export const isMalformedRequestError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return (
    candidate.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    (typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 500)
  );
};

export const publicErrorForUnhandledFailure = (
  error: unknown,
  traceId: string,
): { body: PublicError; statusCode: number } =>
  isMalformedRequestError(error)
    ? createPublicError(RuntimeErrorCode.VALIDATION_ERROR, traceId)
    : mapPublicError(error, traceId);
