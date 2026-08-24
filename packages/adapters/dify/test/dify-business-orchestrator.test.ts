import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RuntimeErrorCode,
  type OrchestrationEvent,
  type OrchestrationInput,
} from "@skein-chatbot/core";

import {
  createDifyBusinessOrchestrator,
  DifyProfileSchema,
  type DifyProfile,
} from "../src/index.js";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

let handler: Handler;
let baseUrl: string;
let server: ReturnType<typeof createServer>;

const readRequest = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
};

const sendJson = (
  response: ServerResponse,
  body: unknown,
  status = 200,
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const sse = (payload: unknown, newline = "\n"): string =>
  `data: ${JSON.stringify(payload)}${newline}${newline}`;

const defaultProfile = (): DifyProfile =>
  DifyProfileSchema.parse({
    name: "test",
    request: {
      query: "query_copy",
      context: "context_payload",
      memory: "memory_payload",
      mode: "execution_mode",
      traceId: "trace_id",
      user: "requester_id",
    },
    modeMapping: { QUICK: "FAST", DEEP: "THOROUGH" },
    response: {
      answer: "answer",
      status: "result_status",
      sources: "metadata.retriever_resources",
      followUpQuestion: "follow_up.question",
      followUpGuidance: "follow_up.guidance",
      conversationId: "conversation_id",
      contextPatch: {
        conversation: "context_patch.conversation",
        workflowState: "context_patch.workflow_state",
      },
    },
    statusMapping: {
      ok: "ANSWER",
      limited: "PARTIAL",
      none: "NO_EVIDENCE",
      transfer: "HANDOFF",
    },
    source: {
      id: ["segment_id", "id"],
      title: ["document_name", "title"],
      url: "url",
      provider: "origin",
      metadata: "doc_metadata",
    },
    stream: {
      event: "event",
      text: "answer",
      conversationId: "conversation_id",
      textEvents: ["message", "agent_message"],
      terminalEvents: ["message_end"],
      errorEvents: ["error"],
      statusMapping: {
        workflow_started: "Processing request",
        retrieval_started: "Searching knowledge",
        message: "Preparing response",
      },
    },
    transport: { executeResponseMode: "blocking" },
  }) as DifyProfile;

const input = (
  overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput => ({
  traceId: "trace-1",
  turnId: "turn-1",
  sessionId: "session-1",
  query: "A generic question",
  mode: "QUICK",
  context: {
    version: "1.0",
    revision: 0,
    conversation: { language: "en" },
    workflow: { state: { step: 1 } },
    runtime: {},
  },
  memory: { recentMessages: [] },
  user: { userId: "opaque-user-1" },
  ...overrides,
});

const collect = async (
  events: AsyncIterable<OrchestrationEvent>,
): Promise<OrchestrationEvent[]> => {
  const values: OrchestrationEvent[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
};

const orchestrator = (
  options: {
    apiKey?: string;
    profile?: DifyProfile;
    files?: () => readonly [{
      type: "document";
      transfer_method: "remote_url";
      url: string;
    }];
  } = {},
) =>
  createDifyBusinessOrchestrator({
    baseUrl,
    apiKey: options.apiKey ?? "test-app-key",
    profile: options.profile ?? defaultProfile(),
    ...(options.files === undefined ? {} : { files: options.files }),
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

describe("DifyBusinessOrchestrator blocking transport", () => {
  it("sends the standard envelope and normalizes a blocking response", async () => {
    handler = async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat-messages");
      expect(request.headers.authorization).toBe("Bearer test-app-key");
      const body = await readRequest(request);
      expect(body).toMatchObject({
        query: "A generic question",
        response_mode: "blocking",
        user: "opaque-user-1",
        inputs: {
          query_copy: "A generic question",
          execution_mode: "FAST",
          trace_id: "trace-1",
          requester_id: "opaque-user-1",
        },
      });
      expect(body).not.toHaveProperty("conversation_id");
      sendJson(response, {
        event: "message",
        answer: "A generic answer",
        conversation_id: "conversation-1",
        result_status: "limited",
        follow_up: {
          question: "Continue?",
          guidance: "Provide another detail.",
        },
        context_patch: {
          conversation: { topic: "general" },
          workflow_state: { next: "review" },
        },
        metadata: {
          retriever_resources: [
            {
              segment_id: "segment-1",
              document_name: "Generic reference",
              url: "https://example.com/reference",
              origin: "knowledge",
              doc_metadata: { rank: 1 },
            },
            { score: 0.5 },
          ],
        },
      });
    };

    await expect(orchestrator().execute(input())).resolves.toEqual({
      answer: "A generic answer",
      status: "PARTIAL",
      sources: [
        {
          id: "segment-1",
          title: "Generic reference",
          url: "https://example.com/reference",
          provider: "knowledge",
          metadata: { rank: 1 },
        },
      ],
      followUpQuestion: "Continue?",
      followUpGuidance: "Provide another detail.",
      contextPatch: {
        conversation: { topic: "general" },
        workflowState: { next: "review" },
      },
      providerConversationId: "conversation-1",
    });
  });

  it("passes an existing conversation ID and rejects a changed binding", async () => {
    handler = async (request, response) => {
      expect(await readRequest(request)).toMatchObject({
        conversation_id: "conversation-existing",
      });
      sendJson(response, {
        answer: "answer",
        conversation_id: "conversation-changed",
        result_status: "ok",
      });
    };

    await expect(
      orchestrator().execute(
        input({ providerConversationId: "conversation-existing" }),
      ),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("changes only the app key to switch apps on a shared base URL", async () => {
    const seen: { authorization?: string; body?: Record<string, unknown> }[] = [];
    handler = async (request, response) => {
      const authorization = request.headers.authorization;
      const body = await readRequest(request);
      seen.push({
        ...(authorization === undefined ? {} : { authorization }),
        body,
      });
      sendJson(response, {
        answer: authorization?.endsWith("app-a") === true ? "A" : "B",
        conversation_id: `conversation-${seen.length}`,
        result_status: "ok",
      });
    };
    const first = await orchestrator({ apiKey: "app-a" }).execute(
      input({ sessionId: "fresh-a" }),
    );
    const second = await orchestrator({ apiKey: "app-b" }).execute(
      input({ sessionId: "fresh-b" }),
    );

    expect([first.answer, second.answer]).toEqual(["A", "B"]);
    expect(seen.map((value) => value.authorization)).toEqual([
      "Bearer app-a",
      "Bearer app-b",
    ]);
    expect(seen[0]?.body).not.toHaveProperty("conversation_id");
    expect(seen[1]?.body).not.toHaveProperty("conversation_id");
  });

  it("supports optional internal file transport without adding a public field", async () => {
    handler = async (request, response) => {
      expect(await readRequest(request)).toMatchObject({
        files: [
          {
            type: "document",
            transfer_method: "remote_url",
            url: "https://example.com/file.pdf",
          },
        ],
      });
      sendJson(response, {
        answer: "answer",
        conversation_id: "conversation-file",
        result_status: "ok",
      });
    };
    await expect(
      orchestrator({
        files: () => [
          {
            type: "document",
            transfer_method: "remote_url",
            url: "https://example.com/file.pdf",
          },
        ],
      }).execute(input()),
    ).resolves.toMatchObject({ answer: "answer" });
  });

  it("switches two mapping profiles and mode/source mappings without Core changes", async () => {
    const profileA = DifyProfileSchema.parse({
      name: "profile-a",
      request: { context: "context_payload", mode: "execution_mode" },
      modeMapping: { QUICK: "FAST", DEEP: "DETAILED" },
      response: {
        answer: "result.text",
        status: "result.kind",
        sources: "result.references",
        conversationId: "conversation_id",
      },
      statusMapping: { complete: "ANSWER" },
      source: { id: "ref", title: "label" },
    }) as DifyProfile;
    const profileB = DifyProfileSchema.parse({
      name: "profile-b",
      request: { context: "chat_context", mode: "mode" },
      modeMapping: { QUICK: "Q", DEEP: "D" },
      response: {
        answer: "payload.answer",
        status: "payload.status",
        sources: "payload.sources",
        conversationId: "conversation_id",
      },
      statusMapping: { partial: "PARTIAL" },
      source: { id: "key", title: "name" },
    }) as DifyProfile;

    handler = async (request, response) => {
      const body = await readRequest(request);
      const inputs = body.inputs as Record<string, unknown>;
      if (Object.hasOwn(inputs, "context_payload")) {
        expect(inputs.execution_mode).toBe("FAST");
        sendJson(response, {
          conversation_id: "conversation-a",
          result: {
            text: "profile A",
            kind: "complete",
            references: [{ ref: "a", label: "Source A" }],
          },
        });
        return;
      }
      expect(inputs).toHaveProperty("chat_context");
      expect(inputs.mode).toBe("D");
      sendJson(response, {
        conversation_id: "conversation-b",
        payload: {
          answer: "profile B",
          status: "partial",
          sources: [{ key: "b", name: "Source B" }],
        },
      });
    };

    const adapterA = createDifyBusinessOrchestrator({
      baseUrl,
      apiKey: "same-key",
      profile: profileA,
      providerKey: "shared",
    });
    const adapterB = createDifyBusinessOrchestrator({
      baseUrl,
      apiKey: "same-key",
      profile: profileB,
      providerKey: "shared",
    });
    expect(adapterA.providerKey).toBe("shared:profile-a");
    expect(adapterB.providerKey).toBe("shared:profile-b");
    await expect(adapterA.execute(input({ mode: "QUICK" }))).resolves.toMatchObject({
      answer: "profile A",
      status: "ANSWER",
      sources: [{ id: "a", title: "Source A" }],
    });
    await expect(adapterB.execute(input({ mode: "DEEP" }))).resolves.toMatchObject({
      answer: "profile B",
      status: "PARTIAL",
      sources: [{ id: "b", title: "Source B" }],
    });
  });

  it.each([
    [401, "unauthorized", RuntimeErrorCode.PROVIDER_UNAVAILABLE, false],
    [429, "too_many_requests", RuntimeErrorCode.PROVIDER_RATE_LIMITED, true],
    [429, "rate_limit_error", RuntimeErrorCode.PROVIDER_RATE_LIMITED, false],
    [500, "internal_server_error", RuntimeErrorCode.PROVIDER_UNAVAILABLE, true],
  ])(
    "maps HTTP %i without exposing provider payloads",
    async (status, code, expectedCode, retryable) => {
      handler = (_request, response) => {
        sendJson(response, { code, message: "sensitive provider detail" }, status);
      };
      let failure: unknown;
      try {
        await orchestrator().execute(input());
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: expectedCode, retryable });
      expect((failure as Error).message).not.toContain("sensitive");
    },
  );

  it("maps an AbortSignal timeout to PROVIDER_TIMEOUT", async () => {
    handler = () => {
      // Deliberately leave the response open until fetch observes the signal.
    };
    await expect(
      orchestrator().execute(input(), AbortSignal.timeout(20)),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
      retryable: true,
    });
  });

  it("maps an already-timed-out signal before opening transport", async () => {
    const timeoutSignal = AbortSignal.abort(
      new DOMException("test timeout", "TimeoutError"),
    );
    await expect(
      orchestrator().execute(input(), timeoutSignal),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
      retryable: true,
    });
  });

  it("rejects invalid blocking JSON and invalid success shape", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    };
    await expect(orchestrator().execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });

    handler = (_request, response) => {
      sendJson(response, { answer: 42, conversation_id: "conversation-1" });
    };
    await expect(orchestrator().execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("rejects an incompatible success content type", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(
        JSON.stringify({ answer: "answer", conversation_id: "conversation" }),
      );
    };
    await expect(orchestrator().execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("classifies malformed blocking UTF-8 as an invalid response", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0xc3, 0x28]));
    };
    await expect(orchestrator().execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });
});

describe("DifyBusinessOrchestrator streaming transport", () => {
  it("parses fragmented UTF-8, CRLF, comments, coalesced frames, and sources", async () => {
    handler = async (request, response) => {
      expect(await readRequest(request)).toMatchObject({
        response_mode: "streaming",
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const payload = Buffer.from(
        `: ping\r\n\r\n${sse(
          {
            event: "message",
            answer: "你",
            conversation_id: "conversation-stream",
          },
          "\r\n",
        )}${sse(
          {
            event: "message",
            answer: "好",
            conversation_id: "conversation-stream",
          },
          "\r\n",
        )}${sse(
          {
            event: "message_end",
            conversation_id: "conversation-stream",
            result_status: "ok",
            metadata: {
              retriever_resources: [
                { segment_id: "s1", document_name: "Reference" },
              ],
            },
          },
          "\r\n",
        )}`,
        "utf8",
      );
      const split = payload.indexOf(Buffer.from("你")) + 1;
      response.write(payload.subarray(0, split));
      response.write(payload.subarray(split));
      response.end();
    };

    const events = await collect(orchestrator().stream(input()));
    expect(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("你好");
    expect(events).toContainEqual({
      type: "source",
      source: { id: "s1", title: "Reference" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: {
        answer: "你好",
        providerConversationId: "conversation-stream",
      },
    });
  });

  it("does not double-append a New Agent closing full message", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          event: "agent_message",
          answer: "Hel",
          conversation_id: "conversation-agent",
        }) +
          sse({
            event: "agent_message",
            answer: "lo",
            conversation_id: "conversation-agent",
          }) +
          sse({
            event: "message",
            answer: "Hello",
            conversation_id: "conversation-agent",
          }) +
          sse({
            event: "message_end",
            conversation_id: "conversation-agent",
            result_status: "ok",
          }),
      );
    };
    const events = await collect(orchestrator().stream(input()));
    expect(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: { answer: "Hello" },
    });
  });

  it("waits for successful workflow_finished after message_end", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          event: "workflow_started",
          conversation_id: "conversation-flow",
        }) +
          sse({
            event: "message",
            answer: "Flow answer",
            conversation_id: "conversation-flow",
          }) +
          sse({
            event: "message_end",
            conversation_id: "conversation-flow",
            result_status: "ok",
          }) +
          sse({
            event: "workflow_finished",
            conversation_id: "conversation-flow",
            data: { status: "succeeded" },
          }),
      );
    };
    const events = await collect(orchestrator().stream(input()));
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: { answer: "Flow answer" },
    });
  });

  it("waits for and maps the error after a failed workflow terminal", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          event: "workflow_started",
          conversation_id: "conversation-flow-failed",
        }) +
          sse({
            event: "workflow_finished",
            conversation_id: "conversation-flow-failed",
            data: { status: "failed" },
          }) +
          sse({
            event: "error",
            status: 500,
            code: "internal_server_error",
            message: "provider detail",
          }),
      );
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      retryable: true,
    });
  });

  it("maps an HTTP-200 embedded stream error", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          event: "error",
          status: 429,
          code: "too_many_requests",
          message: "provider detail",
        }),
      );
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_RATE_LIMITED,
      retryable: true,
    });
  });

  it("preserves non-retryable quota semantics for stream rate_limit_error", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({ event: "error", status: 429, code: "rate_limit_error" }),
      );
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_RATE_LIMITED,
      retryable: false,
    });
  });

  it("classifies malformed streamed UTF-8 as an invalid response", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28]));
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("rejects a cumulative stream answer over the bounded limit", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = "x".repeat(700 * 1024);
      for (let index = 0; index < 13; index += 1) {
        response.write(
          sse({
            event: "message",
            answer: chunk,
            conversation_id: "conversation-large",
          }),
        );
      }
      response.end();
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it.each([
    ["early EOF", sse({ event: "message", answer: "partial" })],
    ["DONE without result", "data: [DONE]\n\n"],
    [
      "invalid JSON",
      "data: {invalid\n\n",
    ],
    [
      "message replacement",
      sse({
        event: "message_replace",
        answer: "replacement",
        conversation_id: "conversation-1",
      }),
    ],
  ])("rejects broken stream: %s", async (_label, frames) => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frames);
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("rejects inconsistent stream conversation IDs", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({ event: "message", answer: "a", conversation_id: "one" }) +
          sse({ event: "message_end", conversation_id: "two" }),
      );
    };
    await expect(collect(orchestrator().stream(input()))).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
  });

  it("cancels an active stream with AbortSignal", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sse({
          event: "message",
          answer: "first",
          conversation_id: "conversation-abort",
        }),
      );
    };
    const controller = new AbortController();
    const stream = orchestrator().stream(input(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "status", status: "Preparing response" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "delta", text: "first" },
    });
    const pending = iterator.next();
    controller.abort("test abort");
    await expect(pending).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });
  });

  it("can aggregate streaming mode for execute on streaming-only apps", async () => {
    const profile = DifyProfileSchema.parse({
      ...defaultProfile(),
      transport: { executeResponseMode: "streaming" },
    }) as DifyProfile;
    handler = async (request, response) => {
      expect(await readRequest(request)).toMatchObject({
        response_mode: "streaming",
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          event: "agent_message",
          answer: "stream-only",
          conversation_id: "conversation-stream-only",
        }) +
          sse({
            event: "message_end",
            conversation_id: "conversation-stream-only",
            result_status: "ok",
          }),
      );
    };
    await expect(orchestrator({ profile }).execute(input())).resolves.toMatchObject(
      { answer: "stream-only" },
    );
  });
});
