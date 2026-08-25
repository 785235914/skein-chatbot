import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeErrorCode } from "@skein-chatbot/core";

import { createDifyConversationHistorySource } from "../src/index.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

let handler: Handler;
let baseUrl: string;
let server: ReturnType<typeof createServer>;

const messageId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const message = (
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: messageId(index),
  conversation_id: "conversation-1",
  query: `question-${index}`,
  answer: `answer-${index}`,
  created_at: index,
  ...overrides,
});

const sendJson = (
  response: ServerResponse,
  body: unknown,
  status = 200,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const source = (
  overrides: Partial<Parameters<typeof createDifyConversationHistorySource>[0]> = {},
) =>
  createDifyConversationHistorySource({
    baseUrl,
    apiKey: "test-key",
    ...overrides,
  });

beforeEach(async () => {
  handler = (_request, response) => {
    sendJson(response, { error: "handler not configured" }, 500);
  };
  server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
});

describe("Dify conversation history", () => {
  it("paginates with first_id and returns chronological canonical entries", async () => {
    let page = 0;
    handler = (request, response) => {
      page += 1;
      expect(request.method).toBe("GET");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers.accept).toBe("application/json");
      const url = new URL(request.url ?? "", baseUrl);
      expect(url.pathname).toBe("/v1/messages");
      expect(url.searchParams.get("conversation_id")).toBe("conversation-1");
      expect(url.searchParams.get("user")).toBe("demo-user");
      expect(url.searchParams.get("limit")).toBe("100");
      if (page === 1) {
        expect(url.searchParams.has("first_id")).toBe(false);
        sendJson(response, {
          limit: 100,
          has_more: true,
          data: [message(4), message(3)],
        });
        return;
      }
      expect(url.searchParams.get("first_id")).toBe(messageId(4));
      sendJson(response, {
        limit: 100,
        has_more: false,
        data: [message(2), message(1)],
      });
    };

    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).resolves.toEqual(
      [1, 2, 3, 4].map((index) => ({
        id: messageId(index),
        userContent: `question-${index}`,
        assistantContent: `answer-${index}`,
        createdAt: new Date(index * 1_000).toISOString(),
      })),
    );
    expect(page).toBe(2);
  });

  it("never reads more than 200 rows", async () => {
    let page = 0;
    handler = (_request, response) => {
      page += 1;
      const upper = page === 1 ? 200 : 100;
      const lower = page === 1 ? 101 : 1;
      sendJson(response, {
        limit: 100,
        has_more: true,
        data: Array.from({ length: 100 }, (_, offset) =>
          message(upper - offset),
        ).filter((entry) => Number(entry.created_at) >= lower),
      });
    };

    const result = await source().loadHistory({
      externalConversationId: "conversation-1",
      userId: "demo-user",
      maximumEntries: 500,
    });

    expect(result).toHaveLength(200);
    expect(result[0]?.id).toBe(messageId(1));
    expect(result.at(-1)?.id).toBe(messageId(200));
    expect(page).toBe(2);
  });

  it("rejects repeated cursors and empty pagination progress", async () => {
    let page = 0;
    handler = (_request, response) => {
      page += 1;
      sendJson(
        response,
        page === 1
          ? { has_more: true, data: [message(2), message(1)] }
          : { has_more: true, data: [message(2)] },
      );
    };
    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });

    handler = (_request, response) => {
      sendJson(response, { has_more: true, data: [] });
    };
    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });
  });

  it.each([
    [401, RuntimeErrorCode.PROVIDER_UNAVAILABLE],
    [404, RuntimeErrorCode.ORCHESTRATION_FAILED],
    [429, RuntimeErrorCode.PROVIDER_RATE_LIMITED],
    [500, RuntimeErrorCode.PROVIDER_UNAVAILABLE],
  ])("maps HTTP %i to a provider-neutral error", async (status, code) => {
    handler = (_request, response) => {
      sendJson(response, { message: "private provider detail" }, status);
    };

    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("maps aborts without opening a provider request", async () => {
    let requests = 0;
    handler = () => {
      requests += 1;
    };

    await expect(
      source().loadHistory(
        {
          externalConversationId: "conversation-1",
          userId: "demo-user",
          maximumEntries: 200,
        },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.ABORTED });
    expect(requests).toBe(0);
  });

  it.each([
    ["invalid content type", "text/plain", JSON.stringify({ has_more: false, data: [] })],
    ["invalid JSON", "application/json", "not-json"],
  ])("rejects %s", async (_label, contentType, body) => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    };

    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });
  });

  it("rejects oversized response bodies", async () => {
    handler = (_request, response) => {
      sendJson(response, {
        has_more: false,
        data: [message(1, { answer: "x".repeat(256) })],
      });
    };

    await expect(
      source({ maximumResponseBytes: 128 }).loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });
  });

  it.each([
    ["duplicate IDs", [message(1), message(1)]],
    ["changed conversation", [message(1, { conversation_id: "conversation-2" })]],
    ["invalid message ID", [message(1, { id: "not-a-uuid" })]],
    ["invalid timestamp", [message(1, { created_at: Number.POSITIVE_INFINITY })]],
    ["out-of-range timestamp", [message(1, { created_at: Number.MAX_SAFE_INTEGER })]],
  ])("rejects %s", async (_label, data) => {
    handler = (_request, response) => {
      sendJson(response, { has_more: false, data });
    };

    await expect(
      source().loadHistory({
        externalConversationId: "conversation-1",
        userId: "demo-user",
        maximumEntries: 200,
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });
  });

  it("never exposes credentials, URLs, or conversation identifiers in errors", async () => {
    const privateKey = "private-history-key-must-not-leak";
    const privateConversation = "private-conversation-must-not-leak";
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    };
    let captured: unknown;
    try {
      await source({ apiKey: privateKey }).loadHistory({
        externalConversationId: privateConversation,
        userId: "demo-user",
        maximumEntries: 200,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(captured).toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
    expect(JSON.stringify(captured)).not.toContain(privateKey);
    expect(JSON.stringify(captured)).not.toContain(privateConversation);
    expect(JSON.stringify(captured)).not.toContain(baseUrl);
  });
});
