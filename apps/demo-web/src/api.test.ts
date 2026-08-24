import { describe, expect, it } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  RuntimeEvent,
} from "@skein-chatbot/contracts";

import {
  ApiClientError,
  RuntimeEventStreamParser,
  createApiClient,
  parseRuntimeEventBlock,
} from "./api.js";

const responsePayload: ChatResponse = {
  answer: "Hello from the runtime.",
  followUpGuidance: "",
  followUpQuestion: "",
  metadata: {},
  sessionId: "session-1",
  sources: [],
  status: "ANSWER",
  turnId: "turn-1",
};

describe("RuntimeEventStreamParser", () => {
  it("parses fragmented CRLF frames and ignores SSE comments", () => {
    const parser = new RuntimeEventStreamParser();

    expect(parser.push(": keep-alive\r\nevent: assistant.delta\r\nda")).toEqual(
      [],
    );
    expect(
      parser.push('ta: {"type":"assistant.delta","text":"Hi"}\r\n\r\n'),
    ).toEqual([{ type: "assistant.delta", text: "Hi" }]);
    expect(parser.finish()).toEqual([]);
  });

  it("parses more than one canonical event from a chunk", () => {
    const parser = new RuntimeEventStreamParser();
    const frames = [
      'event: turn.started\ndata: {"type":"turn.started"}',
      'event: status.changed\ndata: {"type":"status.changed","status":"Preparing response"}',
    ].join("\n\n");

    expect(parser.push(`${frames}\n\n`)).toEqual([
      { type: "turn.started" },
      { type: "status.changed", status: "Preparing response" },
    ]);
  });

  it("rejects a mismatched SSE event name", () => {
    expect(() =>
      parseRuntimeEventBlock(
        'event: turn.started\ndata: {"type":"assistant.delta","text":"x"}',
      ),
    ).toThrow(ApiClientError);
  });
});

describe("createApiClient", () => {
  it("maps blocking chat calls to the public REST endpoint", async () => {
    let observedUrl = "";
    let observedRequest: RequestInit | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedRequest = init;
      return new Response(JSON.stringify(responsePayload), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };
    const client = createApiClient({
      baseUrl: "https://example.com/",
      fetchImplementation,
    });
    const request: ChatRequest = { message: "Hello", mode: "quick" };

    await expect(client.chat(request)).resolves.toEqual(responsePayload);
    expect(observedUrl).toBe("https://example.com/api/v1/chat");
    expect(observedRequest?.method).toBe("POST");
    expect(JSON.parse(String(observedRequest?.body))).toEqual(request);
  });

  it("maps the stream endpoint and yields validated runtime events", async () => {
    let observedUrl = "";
    const completedEvent: RuntimeEvent = {
      type: "turn.completed",
      result: responsePayload,
    };
    const fetchImplementation: typeof fetch = async (input) => {
      observedUrl = String(input);
      return new Response(
        `event: turn.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
          status: 200,
        },
      );
    };
    const client = createApiClient({ fetchImplementation });
    const events: RuntimeEvent[] = [];

    for await (const event of client.streamChat({
      message: "Hello",
      mode: "deep",
    })) {
      events.push(event);
    }

    expect(observedUrl).toBe("/api/v1/chat/stream");
    expect(events).toEqual([completedEvent]);
  });

  it("preserves canonical public error details", async () => {
    const publicError = {
      code: "PROVIDER_TIMEOUT",
      message: "The AI service took too long to respond.",
      retryable: true,
      traceId: "trace-1",
    } as const;
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify(publicError), {
        headers: { "Content-Type": "application/json" },
        status: 504,
      });
    const client = createApiClient({ fetchImplementation });

    await expect(client.chat({ message: "Hello" })).rejects.toMatchObject({
      message: publicError.message,
      publicError,
      status: 504,
    });
  });
});
