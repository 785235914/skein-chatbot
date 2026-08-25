import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChatResponseSchema,
  ResumeSessionResponseSchema,
} from "@skein-chatbot/contracts";

import { createApiApp } from "../apps/api/src/app.js";
import { createDefaultApiRuntime } from "../apps/api/src/composition.js";
import { loadApiConfig } from "../apps/api/src/config.js";
import { createApiClient } from "../apps/demo-web/src/api.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];
const providerServers: ReturnType<typeof createServer>[] = [];
const temporaryDirectories: string[] = [];

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const sendJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    providerServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("provider-free public Mock journey", () => {
  it("preserves the canonical REST and SSE journey through the Demo client", async () => {
    const config = loadApiConfig({
      DATABASE_URL: "",
      LOG_LEVEL: "info",
      ORCHESTRATOR_PROVIDER: "mock",
    });
    const runtime = await createDefaultApiRuntime(config);
    const app = await createApiApp({ config, runtime });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createApiClient({ baseUrl });

    await expect(fetch(`${baseUrl}/api/v1/health`).then((response) => response.json())).resolves.toEqual({
      status: "ok",
    });
    await expect(fetch(`${baseUrl}/api/v1/ready`).then((response) => response.json())).resolves.toEqual({
      checks: { runtime: true },
      status: "ready",
    });

    const first = await client.chat({
      message: "Find a source",
      metadata: { mockScenario: "sources" },
      mode: "quick",
    });
    expect(first).toMatchObject({
      answer: "Mock sourced answer for: Find a source",
      sources: [
        {
          id: "mock-source-1",
          provider: "mock",
          title: "Mock reference",
          url: "https://example.com/reference",
        },
      ],
      status: "ANSWER",
    });

    const followUp = await client.chat({
      message: "Continue the work",
      metadata: { mockScenario: "handoff" },
      mode: "deep",
      sessionId: first.sessionId,
    });
    expect(followUp).toMatchObject({
      followUpGuidance: "Continue with a human support channel.",
      sessionId: first.sessionId,
      status: "HANDOFF",
    });

    const session = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}`).then(
      (response) => response.json(),
    );
    expect(session).toMatchObject({ id: first.sessionId, revision: 2, status: "ACTIVE" });
    const messages = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/messages`).then(
      (response) => response.json() as Promise<{ messages: Array<{ content: string; role: string }> }>,
    );
    expect(messages.messages.map(({ content, role }) => ({ content, role }))).toEqual([
      { content: "Find a source", role: "USER" },
      { content: "Mock sourced answer for: Find a source", role: "ASSISTANT" },
      { content: "Continue the work", role: "USER" },
      { content: "Mock handoff response for: Continue the work", role: "ASSISTANT" },
    ]);

    const events = [] as Array<{ type: string }>;
    for await (const event of client.streamChat({
      message: "Stream this",
      metadata: { mockScenario: "stream" },
      sessionId: first.sessionId,
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status.changed",
      "assistant.delta",
      "assistant.delta",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed")).toHaveLength(1);

    const reset = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/reset`, {
      method: "POST",
    }).then((response) => response.json());
    expect(reset).toMatchObject({ sessionId: first.sessionId, status: "RESET" });
    await expect(
      fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/messages`).then((response) => response.json()),
    ).resolves.toEqual({ messages: [] });
  });
});

describe("provider conversation restart journey", () => {
  it("restores chronological history in a fresh runtime and continues the private binding", async () => {
    const externalConversationId = "private-provider-conversation";
    const providerBodies: Record<string, unknown>[] = [];
    const historyTimestamp = Math.floor(Date.now() / 1_000) - 5;
    const providerServer = createServer((request, response) => {
      Promise.resolve()
        .then(async () => {
          const requestUrl = new URL(
            request.url ?? "",
            "http://127.0.0.1",
          );
          if (request.method === "GET" && requestUrl.pathname === "/v1/messages") {
            expect(requestUrl.searchParams.get("conversation_id")).toBe(
              externalConversationId,
            );
            expect(requestUrl.searchParams.get("user")).toBe("demo-user");
            sendJson(response, {
              has_more: false,
              data: [
                {
                  id: "00000000-0000-4000-8000-000000000002",
                  conversation_id: externalConversationId,
                  query: "Second historical question",
                  answer: "Second historical answer",
                  created_at: historyTimestamp + 2,
                },
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  conversation_id: externalConversationId,
                  query: "First historical question",
                  answer: "First historical answer",
                  created_at: historyTimestamp,
                },
              ],
            });
            return;
          }
          if (
            request.method === "POST" &&
            requestUrl.pathname === "/v1/chat-messages"
          ) {
            const body = await readRequestBody(request);
            if (typeof body !== "object" || body === null) {
              throw new TypeError("Expected a provider request object.");
            }
            providerBodies.push(body as Record<string, unknown>);
            sendJson(response, {
              answer:
                providerBodies.length === 1
                  ? "Initial provider answer"
                  : "Continued provider answer",
              conversation_id: externalConversationId,
            });
            return;
          }
          response.writeHead(404);
          response.end();
        })
        .catch(() => {
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end();
        });
    });
    providerServers.push(providerServer);
    await new Promise<void>((resolve) => {
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const providerAddress = providerServer.address() as AddressInfo;
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "skein-restart-profile-"),
    );
    temporaryDirectories.push(profileDirectory);
    await writeFile(
      path.join(profileDirectory, "restart.yaml"),
      "name: restart\n",
      "utf8",
    );
    const config = loadApiConfig({
      ORCHESTRATOR_PROVIDER: "dify",
      DIFY_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
      DIFY_API_KEY: "restart-e2e-placeholder-key",
      DIFY_PROFILE: "restart",
      DIFY_PROFILE_DIRECTORY: profileDirectory,
      SESSION_RESUME_SECRET: Buffer.alloc(32, 9).toString("base64"),
    });

    const firstRuntime = await createDefaultApiRuntime(config);
    const firstApp = await createApiApp({ config, runtime: firstRuntime });
    apps.push(firstApp);
    const initialResponse = await firstApp.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "Start provider conversation" },
    });
    expect(initialResponse.statusCode).toBe(200);
    const initial = ChatResponseSchema.parse(initialResponse.json());
    expect(initial.resumeToken).toEqual(expect.any(String));
    expect(initialResponse.body).not.toContain(externalConversationId);
    apps.splice(apps.indexOf(firstApp), 1);
    await firstApp.close();

    const secondRuntime = await createDefaultApiRuntime(config);
    const secondApp = await createApiApp({ config, runtime: secondRuntime });
    apps.push(secondApp);
    const resumeResponse = await secondApp.inject({
      method: "POST",
      url: "/api/v1/sessions/resume",
      payload: { resumeToken: initial.resumeToken },
    });
    expect(resumeResponse.statusCode).toBe(200);
    const resumed = ResumeSessionResponseSchema.parse(resumeResponse.json());
    expect(
      resumed.messages.map(({ content, role }) => ({ content, role })),
    ).toEqual([
      { content: "First historical question", role: "USER" },
      { content: "First historical answer", role: "ASSISTANT" },
      { content: "Second historical question", role: "USER" },
      { content: "Second historical answer", role: "ASSISTANT" },
    ]);
    expect(resumeResponse.body).not.toContain(externalConversationId);

    const continuationResponse = await secondApp.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: {
        sessionId: resumed.session.id,
        message: "Continue provider conversation",
      },
    });
    expect(continuationResponse.statusCode).toBe(200);
    expect(continuationResponse.body).not.toContain(externalConversationId);
    expect(providerBodies).toHaveLength(2);
    expect(providerBodies[0]?.conversation_id).toBeUndefined();
    expect(providerBodies[1]?.conversation_id).toBe(externalConversationId);
  });
});
