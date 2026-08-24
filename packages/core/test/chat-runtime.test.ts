import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@skein-chatbot/contracts";
import {
  InMemoryRuntimeStore,
  ManualClock,
  SequenceIdGenerator,
} from "@skein-chatbot/test-utils";

import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  RuntimeError,
  RuntimeErrorCode,
  normalizeContextPatch,
  type BusinessOrchestrator,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
} from "../src/index.js";

type ExecuteHandler = (
  input: OrchestrationInput,
  signal?: AbortSignal,
) => Promise<OrchestrationResult>;

type StreamHandler = (
  input: OrchestrationInput,
  signal?: AbortSignal,
) => AsyncIterable<OrchestrationEvent>;

const defaultResult = (): OrchestrationResult => ({
  answer: "A canonical answer",
  status: "ANSWER",
  sources: [],
});

class ScriptedOrchestrator implements BusinessOrchestrator {
  readonly inputs: OrchestrationInput[] = [];

  constructor(
    private readonly executeHandler: ExecuteHandler = () =>
      Promise.resolve(defaultResult()),
    private readonly streamHandler?: StreamHandler,
  ) {}

  execute(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    this.inputs.push(input);
    return this.executeHandler(input, signal);
  }

  async *stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent> {
    this.inputs.push(input);
    if (this.streamHandler !== undefined) {
      yield* this.streamHandler(input, signal);
      return;
    }
    yield { type: "completed", result: await this.executeHandler(input, signal) };
  }
}

const createRuntime = (
  orchestrator: BusinessOrchestrator,
  store = new InMemoryRuntimeStore(),
  ids = new SequenceIdGenerator(),
  clock = new ManualClock(),
): { runtime: ChatRuntime; store: InMemoryRuntimeStore; clock: ManualClock } => ({
  runtime: new ChatRuntime({
    orchestrator,
    store,
    config: DEFAULT_RUNTIME_CONFIG,
    provider: "provider",
    providerKey: "default",
    clock,
    idGenerator: ids,
  }),
  store,
  clock,
});

const collectEvents = async (
  events: AsyncIterable<RuntimeEvent>,
): Promise<RuntimeEvent[]> => {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

describe("ChatRuntime blocking turns", () => {
  it("creates a session, immutable snapshot, messages, and canonical response", async () => {
    const orchestrator = new ScriptedOrchestrator(() =>
      Promise.resolve({
        answer: "Done",
        status: "ANSWER",
        sources: [
          { title: "Reference", url: "https://example.com/reference" },
        ],
        providerConversationId: "external-conversation",
        providerMetadata: { internal: "must-not-leak" },
      }),
    );
    const { runtime, store } = createRuntime(
      orchestrator,
      new InMemoryRuntimeStore(),
      new SequenceIdGenerator([
        "trace-1",
        "turn-1",
        "session-1",
        "message-1",
        "message-2",
      ]),
    );

    const response = await runtime.chat({
      message: "Hello",
      mode: "quick",
      user: { userId: "user-1", metadata: { locale: "en" } },
    });

    expect(response).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      answer: "Done",
      status: "ANSWER",
      sources: [
        { title: "Reference", url: "https://example.com/reference" },
      ],
      followUpQuestion: "",
      followUpGuidance: "",
      metadata: {},
    });
    expect(JSON.stringify(response)).not.toContain("must-not-leak");
    expect(await runtime.getSession("session-1")).toMatchObject({
      revision: 1,
      status: "ACTIVE",
      userId: "user-1",
    });
    expect(await runtime.getMessages("session-1")).toMatchObject([
      { role: "USER", content: "Hello" },
      { role: "ASSISTANT", content: "Done" },
    ]);
    expect(Object.isFrozen(orchestrator.inputs[0])).toBe(true);
    expect(Object.isFrozen(orchestrator.inputs[0]?.context.workflow.state)).toBe(
      true,
    );
    expect(
      (await store.loadSessionAggregate("session-1"))?.providerBindings,
    ).toEqual([
      {
        sessionId: "session-1",
        provider: "provider",
        providerKey: "default",
        externalConversationId: "external-conversation",
      },
    ]);
  });

  it("loads an existing session, recent memory, and provider binding", async () => {
    const orchestrator = new ScriptedOrchestrator((input) =>
      Promise.resolve({
        ...defaultResult(),
        providerConversationId:
          input.providerConversationId ?? "external-conversation",
      }),
    );
    const { runtime } = createRuntime(orchestrator);

    const first = await runtime.chat({
      sessionId: "session-1",
      message: "First",
      user: { userId: "user-1" },
    });
    const second = await runtime.chat({
      sessionId: first.sessionId,
      message: "Second",
      mode: "deep",
      user: { userId: "user-1" },
    });

    expect(second.sessionId).toBe("session-1");
    expect(orchestrator.inputs[1]).toMatchObject({
      mode: "DEEP",
      providerConversationId: "external-conversation",
      memory: {
        recentMessages: [
          { role: "USER", content: "First" },
          { role: "ASSISTANT", content: "A canonical answer" },
        ],
      },
    });
    expect(await runtime.getSession("session-1")).toMatchObject({ revision: 2 });
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
  });

  it("merges a conservative context patch and keeps runtime fields owned", async () => {
    const orchestrator = new ScriptedOrchestrator(() =>
      Promise.resolve({
        ...defaultResult(),
        contextPatch: {
          conversation: { topic: "generic-topic" },
          workflowState: { phase: "updated" },
        },
      }),
    );
    const { runtime, store } = createRuntime(orchestrator);

    const response = await runtime.chat({
      sessionId: "session-1",
      message: "Update context",
      user: { userId: "user-1" },
    });
    const aggregate = await store.loadSessionAggregate(response.sessionId);

    expect(aggregate?.context).toMatchObject({
      revision: 1,
      conversation: { topic: "generic-topic" },
      workflow: { state: { phase: "updated" } },
      runtime: { lastTurnId: response.turnId },
    });
    expect(() => normalizeContextPatch({ runtime: { updatedAt: "x" } })).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
    expect(() =>
      normalizeContextPatch({ workflowState: { revision: 99 } }),
    ).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
  });

  it("resets messages, context, summary, and provider bindings atomically", async () => {
    const orchestrator = new ScriptedOrchestrator(() =>
      Promise.resolve({
        ...defaultResult(),
        providerConversationId: "external-conversation",
      }),
    );
    const { runtime, store } = createRuntime(orchestrator);
    await runtime.chat({
      sessionId: "session-1",
      message: "Before reset",
      user: { userId: "user-1" },
    });

    await expect(runtime.resetSession("session-1")).resolves.toEqual({
      sessionId: "session-1",
      status: "RESET",
      revision: 2,
    });
    expect(await runtime.getMessages("session-1")).toEqual([]);
    expect(await store.loadSessionAggregate("session-1")).toMatchObject({
      session: { status: "RESET", revision: 2 },
      context: {
        revision: 2,
        conversation: {},
        workflow: { state: {} },
      },
      providerBindings: [],
    });
  });

  it("does not commit assistant, context, or binding state on failure", async () => {
    let fail = false;
    const orchestrator = new ScriptedOrchestrator(() => {
      if (fail) {
        throw new RuntimeError(
          RuntimeErrorCode.PROVIDER_UNAVAILABLE,
          "Temporarily unavailable.",
          { retryable: true },
        );
      }
      return Promise.resolve({
        ...defaultResult(),
        contextPatch: { workflowState: { stable: true } },
        providerConversationId: "external-conversation",
      });
    });
    const { runtime, store } = createRuntime(orchestrator);
    await runtime.chat({
      sessionId: "session-1",
      message: "Successful turn",
      user: { userId: "user-1" },
    });
    const before = await store.loadSessionAggregate("session-1");
    fail = true;

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Failed turn",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      retryable: true,
    });

    expect(await store.loadSessionAggregate("session-1")).toEqual(before);
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });

  it("enforces revision CAS when two turns load the same session revision", async () => {
    let arrivals = 0;
    let release = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orchestrator = new ScriptedOrchestrator(async () => {
      arrivals += 1;
      if (arrivals === 2) {
        release();
      }
      await barrier;
      return defaultResult();
    });
    const { runtime, store } = createRuntime(orchestrator);
    const request = (message: string) => ({
      sessionId: "session-1",
      message,
      user: { userId: "user-1" },
    });

    const outcomes = await Promise.allSettled([
      runtime.chat(request("Concurrent A")),
      runtime.chat(request("Concurrent B")),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: RuntimeErrorCode.SESSION_CONFLICT,
        }),
      }),
    ]);
    expect(await runtime.getMessages("session-1")).toHaveLength(2);
    expect((await store.loadSessionAggregate("session-1"))?.context.revision).toBe(
      1,
    );
  });
});

describe("ChatRuntime streaming and abort", () => {
  it("maps only safe events and commits before the single completion event", async () => {
    const streamHandler: StreamHandler = async function* () {
      yield { type: "status", status: "private-stage-name" };
      yield { type: "delta", text: "Hello " };
      yield {
        type: "source",
        source: { title: "Reference", url: "https://example.com/source" },
      };
      yield {
        type: "completed",
        result: { ...defaultResult(), answer: "Hello world" },
      };
    };
    const orchestrator = new ScriptedOrchestrator(undefined, streamHandler);
    const { runtime, store } = createRuntime(orchestrator);
    const events: RuntimeEvent[] = [];

    for await (const event of runtime.stream({
      sessionId: "session-1",
      message: "Stream",
      user: { userId: "user-1" },
    })) {
      events.push(event);
      if (event.type === "turn.completed") {
        expect(await store.getSession("session-1")).not.toBeNull();
      }
    }

    expect(events).toEqual([
      { type: "turn.started" },
      { type: "status.changed", status: "Processing request" },
      { type: "assistant.delta", text: "Hello " },
      {
        type: "source.added",
        source: { title: "Reference", url: "https://example.com/source" },
      },
      expect.objectContaining({ type: "turn.completed" }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "turn.completed" || event.type === "turn.failed",
      ),
    ).toHaveLength(1);
  });

  it("turns a stream without completed into one invalid-response terminal", async () => {
    const streamHandler: StreamHandler = async function* () {
      yield { type: "delta", text: "Temporary" };
    };
    const { runtime, store } = createRuntime(
      new ScriptedOrchestrator(undefined, streamHandler),
    );

    const events = await collectEvents(
      runtime.stream({
        sessionId: "session-1",
        message: "Broken stream",
        user: { userId: "user-1" },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE },
    });
    expect(await store.getSession("session-1")).toBeNull();
    expect(await store.getMessages("session-1")).toEqual([]);
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });

  it("propagates abort to an active orchestrator and commits no state", async () => {
    let started = (): void => undefined;
    const wasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const orchestrator = new ScriptedOrchestrator(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          started();
          const abort = (): void => {
            reject(
              new RuntimeError(
                RuntimeErrorCode.ABORTED,
                "The operation was aborted.",
              ),
            );
          };
          if (signal?.aborted === true) {
            abort();
          } else {
            signal?.addEventListener("abort", abort, { once: true });
          }
        }),
    );
    const { runtime, store } = createRuntime(orchestrator);
    const pending = runtime.chat({
      sessionId: "session-1",
      message: "Wait",
      user: { userId: "user-1" },
    });
    await wasStarted;

    await expect(runtime.abortSession("session-1")).resolves.toEqual({
      sessionId: "session-1",
      aborted: true,
    });
    await expect(pending).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });
    await expect(runtime.abortSession("session-1")).resolves.toMatchObject({
      aborted: false,
    });
    expect(await store.getSession("session-1")).toBeNull();
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });
});

describe("ChatRuntime durable provider identity", () => {
  const runtimeWithProviderKey = (providerKey: string): ChatRuntime =>
    new ChatRuntime({
      orchestrator: new ScriptedOrchestrator(),
      store: new InMemoryRuntimeStore(),
      config: DEFAULT_RUNTIME_CONFIG,
      provider: "provider",
      providerKey,
    });

  it("accepts a provider key of exactly 191 characters", () => {
    expect(() => runtimeWithProviderKey("k".repeat(191))).not.toThrow();
  });

  it("rejects a provider key of 192 characters with a fixed safe error", () => {
    expect(() => runtimeWithProviderKey("k".repeat(192))).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.VALIDATION_ERROR,
        message: "The runtime configuration is invalid.",
      }),
    );
  });
});
