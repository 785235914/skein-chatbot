import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatResponseSchema,
  PublicErrorSchema,
  ResumeSessionResponseSchema,
  RuntimeEventSchema,
  type RuntimeEvent,
} from "@skein-chatbot/contracts";
import { MockBusinessOrchestrator } from "@skein-chatbot/adapter-mock";
import { ChatRuntime, DEFAULT_RUNTIME_CONFIG } from "@skein-chatbot/core";
import { InMemoryRuntimeStore } from "@skein-chatbot/test-utils";
import { createPinoObservability } from "@skein-chatbot/observability";

import type { ApiRuntime } from "../src/api-runtime.js";
import { createApiApp } from "../src/app.js";
import { createDefaultApiRuntime } from "../src/composition.js";
import { loadApiConfig } from "../src/config.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  vi.unstubAllEnvs();
});

const createMockRuntime = (delayMs = 60_000): ApiRuntime =>
  new ChatRuntime({
    orchestrator: new MockBusinessOrchestrator({ delayMs }),
    store: new InMemoryRuntimeStore(),
    config: DEFAULT_RUNTIME_CONFIG,
    provider: "mock",
    providerKey: "default",
  });

const parseSseEvents = (payload: string): RuntimeEvent[] =>
  payload
    .split(/\r?\n\r?\n/u)
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/u)
        .find((line) => line.startsWith("data: "));
      if (data === undefined) {
        throw new Error("SSE frame did not contain a data field.");
      }
      return RuntimeEventSchema.parse(JSON.parse(data.slice(6)));
    });

const completedResponse = {
  sessionId: "session-stub",
  turnId: "turn-stub",
  answer: "stub",
  status: "ANSWER" as const,
  sources: [],
  followUpQuestion: "",
  followUpGuidance: "",
  metadata: {},
};

const resumedResponse = {
  session: {
    id: "session-resumed",
    userId: "demo-user",
    status: "ACTIVE" as const,
    revision: 0,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    lastActiveAt: "2026-08-25T00:00:01.000Z",
  },
  messages: [],
  resumeToken: "refreshed-token",
};

const createRuntimeStub = (overrides: Partial<ApiRuntime> = {}): ApiRuntime => ({
  abortSession: (sessionId) => Promise.resolve({ sessionId, aborted: false }),
  chat: () => Promise.resolve(completedResponse),
  getMessages: () => Promise.resolve([]),
  getSession: (sessionId) =>
    Promise.resolve({
      id: sessionId,
      userId: "demo-user",
      status: "ACTIVE",
      revision: 1,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      lastActiveAt: "2026-08-20T00:00:00.000Z",
    }),
  resetSession: (sessionId) =>
    Promise.resolve({ sessionId, status: "RESET", revision: 2 }),
  resumeSession: () => Promise.resolve(resumedResponse),
  stream: async function* () {
    yield { type: "turn.started" };
    yield { type: "turn.completed", result: completedResponse };
  },
  ...overrides,
});

describe("health endpoints", () => {
  it("uses an injected safe logger without exposing query credentials", async () => {
    const secret = "fastify-query-secret";
    const lines: string[] = [];
    const observability = createPinoObservability({
      destination: { write: (chunk: string) => lines.push(chunk) },
    });
    const app = await createApiApp({
      runtime: createRuntimeStub(),
      logger: observability.logger,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/health?token=${secret}`,
      headers: { authorization: `Bearer ${secret}`, cookie: secret },
    });

    expect(response.statusCode).toBe(200);
    const serialized = lines.join("");
    expect(serialized).not.toContain(secret);
    const parsed = lines
      .flatMap((chunk) => chunk.split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    const incoming = parsed.find((line) => line.msg === "incoming request");
    const completed = parsed.find((line) => line.msg === "request completed");
    expect(Object.keys(incoming ?? {}).sort()).toEqual([
      "level",
      "msg",
      "req",
      "reqId",
      "time",
    ]);
    expect(Object.keys((incoming?.req ?? {}) as object).sort()).toEqual([
      "id",
      "method",
      "url",
    ]);
    expect(incoming?.req).toEqual({
      id: "req-1",
      method: "GET",
      url: "/api/v1/health",
    });
    expect(Object.keys(completed ?? {}).sort()).toEqual([
      "level",
      "msg",
      "reqId",
      "res",
      "responseTime",
      "time",
    ]);
    expect(Object.keys((completed?.res ?? {}) as object).sort()).toEqual([
      "statusCode",
    ]);
    expect(completed?.res).toEqual({ statusCode: 200 });
  });

  it("reports liveness", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports an unavailable dependency without exposing details", async () => {
    const app = await createApiApp({ readiness: () => false });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { runtime: false },
    });
  });

  it("does not read or validate environment config for an injected Runtime", async () => {
    vi.stubEnv("ORCHESTRATOR_PROVIDER", "dify");
    vi.stubEnv("DIFY_BASE_URL", "");
    vi.stubEnv("DIFY_API_KEY", "");
    vi.stubEnv("DIFY_PROFILE", "");

    const app = await createApiApp({ runtime: createRuntimeStub() });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("calls an injected Runtime close hook exactly once", async () => {
    const close = vi.fn(() => Promise.resolve());
    const app = await createApiApp({ runtime: createRuntimeStub({ close }) });
    apps.push(app);

    await app.close();
    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("disconnects a composed PostgreSQL Runtime when the app closes", async () => {
    const disconnect = vi.fn(() => Promise.resolve());
    const runtime = await createDefaultApiRuntime(
      loadApiConfig({
        DATABASE_URL:
          "postgresql://placeholder:placeholder@127.0.0.1:5432/skein_chatbot",
      }),
      {
        createPostgresRuntimeStore: () =>
          Promise.resolve({
            store: new InMemoryRuntimeStore(),
            disconnect,
          }),
      },
    );
    const app = await createApiApp({ runtime });
    apps.push(app);

    await app.close();
    await app.close();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("blocking chat and sessions", () => {
  it("resumes a session with a strict body-only token envelope", async () => {
    const resumeSession = vi.fn(
      (_token: string, _user: { userId: string }, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(resumedResponse);
      },
    );
    const app = await createApiApp({
      runtime: createRuntimeStub({ resumeSession }),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/resume",
      payload: { resumeToken: "opaque-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(ResumeSessionResponseSchema.parse(response.json())).toEqual(
      resumedResponse,
    );
    expect(resumeSession).toHaveBeenCalledOnce();
    expect(resumeSession.mock.calls[0]?.slice(0, 2)).toEqual([
      "opaque-token",
      { userId: "demo-user" },
    ]);
  });

  it("rejects malformed resume envelopes and never accepts tokens in a URL", async () => {
    const resumeSession = vi.fn(() => Promise.resolve(resumedResponse));
    const app = await createApiApp({
      runtime: createRuntimeStub({ resumeSession }),
    });
    apps.push(app);

    for (const payload of [
      {},
      { resumeToken: "" },
      { resumeToken: "opaque", unexpected: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/sessions/resume",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(PublicErrorSchema.parse(response.json()).code).toBe(
        "VALIDATION_ERROR",
      );
    }
    const token = "url-token-must-not-be-accepted";
    const queryResponse = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/resume?resumeToken=${token}`,
      payload: {},
    });
    expect(queryResponse.statusCode).toBe(400);
    expect(queryResponse.body).not.toContain(token);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("validates resume output and hides token-bearing runtime failures", async () => {
    const invalidOutputApp = await createApiApp({
      runtime: createRuntimeStub({
        resumeSession: () =>
          Promise.resolve({ ...resumedResponse, resumeToken: "" }),
      }),
    });
    apps.push(invalidOutputApp);
    const invalidOutput = await invalidOutputApp.inject({
      method: "POST",
      url: "/api/v1/sessions/resume",
      payload: { resumeToken: "opaque" },
    });
    expect(invalidOutput.statusCode).toBe(502);
    expect(PublicErrorSchema.parse(invalidOutput.json()).code).toBe(
      "PROVIDER_INVALID_RESPONSE",
    );

    const privateToken = "private-resume-token-must-not-leak";
    const failingApp = await createApiApp({
      runtime: createRuntimeStub({
        resumeSession: () =>
          Promise.reject(new Error(`failed for ${privateToken}`)),
      }),
    });
    apps.push(failingApp);
    const failure = await failingApp.inject({
      method: "POST",
      url: "/api/v1/sessions/resume",
      payload: { resumeToken: privateToken },
    });
    expect(failure.statusCode).toBe(500);
    expect(PublicErrorSchema.parse(failure.json()).code).toBe(
      "INTERNAL_ERROR",
    );
    expect(failure.body).not.toContain(privateToken);
  });

  it("creates a provider-neutral session and canonical response", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "Hello", mode: "quick", metadata: {} },
    });

    expect(response.statusCode).toBe(200);
    const body = ChatResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      answer: "Mock answer for: Hello",
      status: "ANSWER",
      sources: [],
      followUpQuestion: "",
      followUpGuidance: "",
      metadata: {},
    });
    expect(JSON.stringify(body)).not.toMatch(/conversation|providerKey|Dify/ui);
  });

  it("supports multi-turn reload with canonical messages", async () => {
    const app = await createApiApp();
    apps.push(app);

    const first = ChatResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/chat",
          payload: { message: "First" },
        })
      ).json(),
    );
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { sessionId: first.sessionId, message: "Second", mode: "deep" },
    });
    expect(secondResponse.statusCode).toBe(200);

    const sessionResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${first.sessionId}`,
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({
      id: first.sessionId,
      userId: "demo-user",
      status: "ACTIVE",
      revision: 2,
    });

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${first.sessionId}/messages`,
    });
    expect(messagesResponse.statusCode).toBe(200);
    expect(messagesResponse.json()).toMatchObject({
      messages: [
        { role: "USER", content: "First" },
        { role: "ASSISTANT", content: "Mock answer for: First" },
        { role: "USER", content: "Second" },
        { role: "ASSISTANT", content: "Mock answer for: Second" },
      ],
    });
  });

  it("resets a session without deleting its canonical identity", async () => {
    const app = await createApiApp();
    apps.push(app);
    const chat = ChatResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/chat",
          payload: { message: "Reset me" },
        })
      ).json(),
    );

    const reset = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${chat.sessionId}/reset`,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({
      sessionId: chat.sessionId,
      status: "RESET",
      revision: 2,
    });

    const session = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${chat.sessionId}`,
    });
    expect(session.json()).toMatchObject({
      id: chat.sessionId,
      status: "RESET",
      revision: 2,
    });
    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${chat.sessionId}/messages`,
    });
    expect(messages.json()).toEqual({ messages: [] });
  });

  it("returns strict canonical validation and not-found errors", async () => {
    const app = await createApiApp();
    apps.push(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "Hello", provider: "mock" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(PublicErrorSchema.parse(invalid.json())).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
      retryable: false,
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/not-created",
    });
    expect(missing.statusCode).toBe(404);
    expect(PublicErrorSchema.parse(missing.json())).toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: "The session was not found.",
      retryable: false,
    });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { "content-type": "application/json" },
      payload: '{"message":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(PublicErrorSchema.parse(malformed.json())).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
      retryable: false,
    });

    const unsupportedMedia = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { "content-type": "application/xml" },
      payload: "<message>Hello</message>",
    });
    expect(unsupportedMedia.statusCode).toBe(400);
    expect(PublicErrorSchema.parse(unsupportedMedia.json()).code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("maps provider failures without leaking raw errors", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: {
        message: "Please fail",
        metadata: { mockScenario: "rate-limit" },
      },
    });

    expect(response.statusCode).toBe(429);
    const body = PublicErrorSchema.parse(response.json());
    expect(body).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      message: "The AI service is temporarily rate limited.",
      retryable: true,
    });
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "message",
      "retryable",
      "traceId",
    ]);
    expect(response.body).not.toMatch(/stack|mock orchestrator|providerMetadata/i);
  });

  it("returns HTTP 504 with a canonical public error for a composed Mock timeout", async () => {
    const app = await createApiApp({
      config: loadApiConfig({
        QUICK_TIMEOUT_MS: "5",
        RETRY_ATTEMPTS: "0",
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: {
        message: "Bound the provider call",
        mode: "quick",
        metadata: { mockScenario: "timeout" },
      },
    });

    expect(response.statusCode).toBe(504);
    const body = PublicErrorSchema.parse(response.json());
    expect(body).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      message: "The AI service took too long to respond.",
      retryable: true,
    });
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "message",
      "retryable",
      "traceId",
    ]);
    expect(body.traceId.length).toBeGreaterThan(0);
    expect(body.traceId.length).toBeLessThanOrEqual(191);
    expect(response.body).not.toMatch(
      /stack|cause|mock orchestrator|providerMetadata|60_000|60000/iu,
    );
  });

  it("aborts an active turn and returns ABORTED to the pending request", async () => {
    const app = await createApiApp({ runtime: createMockRuntime(5_000) });
    apps.push(app);
    const sessionId = "abort-session";

    const pendingChat = app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: {
        sessionId,
        message: "Wait",
        metadata: { mockScenario: "timeout" },
      },
    });

    let abortResponse: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      abortResponse = await app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/abort`,
      });
      if (abortResponse.json<{ aborted: boolean }>().aborted) {
        break;
      }
    }

    expect(abortResponse?.statusCode).toBe(200);
    expect(abortResponse?.json()).toEqual({ sessionId, aborted: true });
    const chatResponse = await pendingChat;
    expect(chatResponse.statusCode).toBe(409);
    expect(PublicErrorSchema.parse(chatResponse.json())).toMatchObject({
      code: "ABORTED",
      retryable: false,
    });

    const idleAbort = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/abort`,
    });
    expect(idleAbort.json()).toEqual({ sessionId, aborted: false });
  });
});

describe("streaming chat", () => {
  it("emits canonical SSE events in order with one terminal event", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: {
        message: "Stream this",
        metadata: { mockScenario: "stream" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");

    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status.changed",
      "assistant.delta",
      "assistant.delta",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "turn.completed" || event.type === "turn.failed",
      ),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("uses a turn.failed SSE terminal after streaming has started", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: {
        message: "Fail in stream",
        metadata: { mockScenario: "rate-limit" },
      },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status.changed",
      "turn.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: {
        code: "PROVIDER_RATE_LIMITED",
        retryable: true,
      },
    });
    expect(response.body.trimStart()).toMatch(/^event: turn\.started/u);
    expect(response.body).not.toMatch(/"statusCode"|"stack"/u);
  });

  it("normalizes sources into source.added events before completion", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: {
        message: "Find a source",
        metadata: { mockScenario: "sources" },
      },
    });

    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status.changed",
      "assistant.delta",
      "source.added",
      "turn.completed",
    ]);
    expect(events[3]).toMatchObject({
      type: "source.added",
      source: {
        id: "mock-source-1",
        title: "Mock reference",
        url: "https://example.com/reference",
        provider: "mock",
      },
    });
  });

  it("returns JSON validation errors only before opening the stream", async () => {
    const app = await createApiApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: { message: "", unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(PublicErrorSchema.parse(response.json()).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(response.body).not.toContain("event:");
  });

  it("synthesizes a failure when a Runtime stream has no terminal event", async () => {
    const runtime = createRuntimeStub({
      stream: async function* () {
        yield { type: "turn.started" };
      },
    });
    const app = await createApiApp({ runtime });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: { message: "Incomplete" },
    });
    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: "ORCHESTRATION_FAILED" },
    });
  });

  it("closes immediately after the first terminal Runtime event", async () => {
    const runtime = createRuntimeStub({
      stream: async function* () {
        yield { type: "turn.started" };
        yield { type: "turn.completed", result: completedResponse };
        yield { type: "assistant.delta", text: "must not be emitted" };
      },
    });
    const app = await createApiApp({ runtime });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/stream",
      payload: { message: "Terminal" },
    });

    expect(parseSseEvents(response.body).map((event) => event.type)).toEqual([
      "turn.started",
      "turn.completed",
    ]);
    expect(response.body).not.toContain("must not be emitted");
  });

  it("propagates a disconnected HTTP client through AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const runtime = createRuntimeStub({
      stream: async function* (_input, signal) {
        observedSignal = signal;
        yield { type: "turn.started" };
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const app = await createApiApp({ runtime });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the API to listen on a TCP port.");
    }

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/chat/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Disconnect" }),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    controller.abort();

    await vi.waitFor(
      () => {
        expect(observedSignal?.aborted).toBe(true);
      },
      { timeout: 1_000 },
    );
  });
});
