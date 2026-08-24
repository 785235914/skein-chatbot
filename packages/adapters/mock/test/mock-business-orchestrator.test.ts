import { describe, expect, it } from "vitest";

import {
  RuntimeErrorCode,
  type BusinessOrchestrator,
  type OrchestrationEvent,
  type OrchestrationInput,
} from "@skein-chatbot/core";

import { MockBusinessOrchestrator } from "../src/index.js";

const input = (
  overrides: Partial<OrchestrationInput> = {},
): OrchestrationInput => ({
  traceId: "trace-1",
  turnId: "turn-1",
  sessionId: "session-1",
  query: "Hello",
  mode: "QUICK",
  context: {
    version: "1.0",
    revision: 0,
    conversation: {},
    workflow: { state: {} },
    runtime: {},
  },
  memory: { recentMessages: [] },
  user: { userId: "user-1" },
  ...overrides,
});

const collect = async (
  events: AsyncIterable<OrchestrationEvent>,
): Promise<OrchestrationEvent[]> => {
  const collected: OrchestrationEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

describe("MockBusinessOrchestrator", () => {
  it("implements BusinessOrchestrator and returns a simple answer by default", async () => {
    const orchestrator: BusinessOrchestrator = new MockBusinessOrchestrator();

    await expect(
      orchestrator.execute(
        input({ providerConversationId: "existing-conversation" }),
      ),
    ).resolves.toEqual({
      answer: "Mock answer for: Hello",
      status: "ANSWER",
      sources: [],
      providerConversationId: "existing-conversation",
    });
  });

  it("streams status, ordered deltas, and a terminal result", async () => {
    const orchestrator = new MockBusinessOrchestrator({ scenario: "stream" });
    const events = await collect(orchestrator.stream(input()));

    expect(events[0]).toEqual({
      type: "status",
      status: "Processing request",
    });
    expect(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Mock streamed answer for: Hello");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      result: { status: "ANSWER" },
    });
  });

  it("returns and streams canonical sources", async () => {
    const orchestrator = new MockBusinessOrchestrator({ scenario: "sources" });
    const result = await orchestrator.execute(input());
    const events = await collect(orchestrator.stream(input()));

    expect(result.sources).toEqual([
      expect.objectContaining({
        title: "Mock reference",
        url: "https://example.com/reference",
      }),
    ]);
    expect(events).toContainEqual({
      type: "source",
      source: result.sources[0],
    });
  });

  it("returns a partial result with a follow-up question", async () => {
    const result = await new MockBusinessOrchestrator({
      scenario: "partial",
    }).execute(input());

    expect(result).toMatchObject({
      status: "PARTIAL",
      followUpQuestion: "Would you like to continue?",
    });
  });

  it("returns a handoff result with provider-neutral guidance", async () => {
    const result = await new MockBusinessOrchestrator({
      scenario: "handoff",
    }).execute(input());

    expect(result).toMatchObject({
      status: "HANDOFF",
      followUpGuidance: "Continue with a human support channel.",
    });
  });

  it("waits abortably in the timeout scenario", async () => {
    const controller = new AbortController();
    const orchestrator = new MockBusinessOrchestrator({
      scenario: "timeout",
      delayMs: 60_000,
    });
    const pending = orchestrator.execute(input(), controller.signal);

    controller.abort("test abort");

    await expect(pending).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
      retryable: false,
    });
  });

  it("emits a canonical timeout after the configured delay", async () => {
    const orchestrator = new MockBusinessOrchestrator({
      scenario: "timeout",
      delayMs: 1,
    });

    await expect(orchestrator.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
      retryable: true,
    });
  });

  it("normalizes the 429 scenario to a retryable rate-limit error", async () => {
    const orchestrator = new MockBusinessOrchestrator({
      scenario: "rate-limit",
    });

    await expect(orchestrator.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_RATE_LIMITED,
      retryable: true,
    });
  });

  it("normalizes the 500 scenario to a retryable unavailable error", async () => {
    const orchestrator = new MockBusinessOrchestrator({
      scenario: "unavailable",
    });

    await expect(orchestrator.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      retryable: true,
    });
  });

  it("can deliberately return a runtime-invalid result for validation tests", async () => {
    const result = await new MockBusinessOrchestrator({
      scenario: "invalid-result",
    }).execute(input());

    expect(result.answer).toBe(42);
    expect(result.sources).toBe("not-an-array");
  });

  it("proposes a generic context patch without replacing runtime state", async () => {
    const result = await new MockBusinessOrchestrator({
      scenario: "context-patch",
    }).execute(input());

    expect(result.contextPatch).toEqual({
      conversation: { topic: "mock-topic" },
      workflowState: { mockState: "updated" },
    });
    expect(result.contextPatch).not.toHaveProperty("revision");
    expect(result.contextPatch).not.toHaveProperty("runtime");
  });

  it("uses only a typed metadata override and rejects invalid overrides", async () => {
    const orchestrator = new MockBusinessOrchestrator({ scenario: "simple" });

    await expect(
      orchestrator.execute(input({ metadata: { mockScenario: "partial" } })),
    ).resolves.toMatchObject({ status: "PARTIAL" });
    await expect(
      orchestrator.execute(input({ metadata: { mockScenario: "unknown" } })),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.VALIDATION_ERROR });
  });

  it("stops an active stream when its AbortSignal fires", async () => {
    const controller = new AbortController();
    const orchestrator = new MockBusinessOrchestrator({
      scenario: "stream",
      streamDelayMs: 60_000,
    });
    const stream = orchestrator.stream(input(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "status", status: "Processing request" },
    });
    const pending = iterator.next();
    controller.abort("stop stream");

    await expect(pending).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });
  });
});
