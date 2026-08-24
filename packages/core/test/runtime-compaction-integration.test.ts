import { describe, expect, it, vi } from "vitest";

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
  type BusinessOrchestrator,
  type CompactionCommitCommand,
  type CompactionInput,
  type CompactionProvider,
  type ConversationSummary,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
  type RuntimeConfig,
  type SessionAggregate,
} from "../src/index.js";

const now = "2026-01-01T00:00:00.000Z";

const compactedSummary = (
  text = "The first turn was compacted.",
): ConversationSummary => ({
  userGoals: ["Continue the conversation"],
  confirmedFacts: [],
  unresolvedIssues: [],
  entities: {},
  previousActions: [],
  summaryText: text,
  createdAt: now,
});

const runtimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  recentMessages: 2,
  compactionMessageThreshold: 4,
  compactionTokenThreshold: Number.MAX_SAFE_INTEGER,
  guards: { ...DEFAULT_RUNTIME_CONFIG.guards },
  ...overrides,
});

class RecordingOrchestrator implements BusinessOrchestrator {
  readonly inputs: OrchestrationInput[] = [];

  constructor(private readonly order: string[] = []) {}

  execute(input: OrchestrationInput): Promise<OrchestrationResult> {
    this.order.push("business");
    this.inputs.push(input);
    return Promise.resolve({
      answer: `answer-${this.inputs.length}`,
      status: "ANSWER",
      sources: [],
    });
  }

  async *stream(input: OrchestrationInput): AsyncIterable<OrchestrationEvent> {
    this.order.push("business-stream");
    this.inputs.push(input);
    yield {
      type: "completed",
      result: {
        answer: `answer-${this.inputs.length}`,
        status: "ANSWER",
        sources: [],
      },
    };
  }
}

class FailThirdOrchestrator extends RecordingOrchestrator {
  constructor(private readonly failure: RuntimeError) {
    super();
  }

  override execute(input: OrchestrationInput): Promise<OrchestrationResult> {
    if (this.inputs.length === 2) {
      this.inputs.push(input);
      return Promise.reject(this.failure);
    }
    return super.execute(input);
  }
}

interface RuntimeFixtureOptions {
  readonly store?: InMemoryRuntimeStore;
  readonly orchestrator?: RecordingOrchestrator;
  readonly compactionProvider?: CompactionProvider;
  readonly config?: RuntimeConfig;
}

const runtimeFixture = (
  options: RuntimeFixtureOptions = {},
): {
  runtime: ChatRuntime;
  store: InMemoryRuntimeStore;
  orchestrator: RecordingOrchestrator;
} => {
  const store = options.store ?? new InMemoryRuntimeStore();
  const orchestrator = options.orchestrator ?? new RecordingOrchestrator();
  return {
    runtime: new ChatRuntime({
      orchestrator,
      store,
      config: options.config ?? runtimeConfig(),
      provider: "provider",
      providerKey: "default",
      clock: new ManualClock(now),
      idGenerator: new SequenceIdGenerator(),
      ...(options.compactionProvider === undefined
        ? {}
        : { compactionProvider: options.compactionProvider }),
    }),
    store,
    orchestrator,
  };
};

const runTwoTurns = async (runtime: ChatRuntime): Promise<void> => {
  await runtime.chat({
    sessionId: "session-1",
    message: "First",
    user: { userId: "user-1" },
  });
  await runtime.chat({
    sessionId: "session-1",
    message: "Second",
    user: { userId: "user-1" },
  });
};

const collect = async (
  iterable: AsyncIterable<RuntimeEvent>,
): Promise<RuntimeEvent[]> => {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

class ConflictOnCompactionStore extends InMemoryRuntimeStore {
  override commitCompaction(
    _command: CompactionCommitCommand,
  ): Promise<void> {
    return Promise.reject(
      new RuntimeError(
        RuntimeErrorCode.SESSION_CONFLICT,
        "The session revision did not match.",
      ),
    );
  }
}

class InvalidReloadStore extends InMemoryRuntimeStore {
  private corruptReload = false;

  override async commitCompaction(
    command: CompactionCommitCommand,
  ): Promise<void> {
    await super.commitCompaction(command);
    this.corruptReload = true;
  }

  override async loadSessionAggregate(
    sessionId: string,
  ): Promise<SessionAggregate | null> {
    const aggregate = await super.loadSessionAggregate(sessionId);
    if (!this.corruptReload || aggregate === null) {
      return aggregate;
    }
    return {
      ...aggregate,
      context: {
        ...aggregate.context,
        revision: aggregate.context.revision + 1,
      },
    };
  }
}

describe("ChatRuntime memory and compaction integration", () => {
  it("accepts exactly one concurrent compaction for the same messages", async () => {
    const { runtime, store } = runtimeFixture();
    await runTwoTurns(runtime);
    const aggregate = await store.loadSessionAggregate("session-1");
    expect(aggregate).not.toBeNull();
    const compactedMessageIds =
      aggregate?.messages.map((message) => message.id) ?? [];
    const command: CompactionCommitCommand = {
      sessionId: "session-1",
      expectedRevision: 2,
      summary: compactedSummary(),
      compactedMessageIds,
      committedAt: now,
    };

    const results = await Promise.allSettled([
      store.commitCompaction(command),
      store.commitCompaction(command),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: RuntimeErrorCode.SESSION_CONFLICT,
        }),
      }),
    ]);
    expect((await store.loadSessionAggregate("session-1"))?.messages).toEqual(
      [],
    );
    expect((await store.getSession("session-1"))?.revision).toBe(2);
    expect(await store.getMessages("session-1")).toHaveLength(4);
  });

  it("compacts before orchestration, reloads memory, and preserves public history", async () => {
    const order: string[] = [];
    const orchestrator = new RecordingOrchestrator(order);
    const summarize = vi.fn(
      (input: CompactionInput, signal?: AbortSignal) => {
        order.push("compaction");
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(input.messages.map(({ content }) => content)).toEqual([
          "First",
          "answer-1",
        ]);
        return Promise.resolve(compactedSummary());
      },
    );
    const { runtime, store } = runtimeFixture({
      orchestrator,
      compactionProvider: { summarize },
    });

    await runTwoTurns(runtime);
    expect(summarize).not.toHaveBeenCalled();
    order.length = 0;

    await runtime.chat({
      sessionId: "session-1",
      message: "Third",
      user: { userId: "user-1" },
    });

    expect(order).toEqual(["compaction", "business"]);
    expect(summarize).toHaveBeenCalledOnce();
    expect(orchestrator.inputs[2]?.memory).toMatchObject({
      recentMessages: [
        { role: "USER", content: "Second" },
        { role: "ASSISTANT", content: "answer-2" },
      ],
      summary: { summaryText: "The first turn was compacted." },
    });
    expect(Object.isFrozen(orchestrator.inputs[2]?.memory)).toBe(true);
    expect((await runtime.getMessages("session-1")).map(({ content }) => content)).toEqual([
      "First",
      "answer-1",
      "Second",
      "answer-2",
      "Third",
      "answer-3",
    ]);
    expect(
      (await store.loadSessionAggregate("session-1"))?.messages.map(
        ({ content }) => content,
      ),
    ).toEqual(["Second", "answer-2", "Third", "answer-3"]);
  });

  it("uses the deterministic provider-free fallback by default", async () => {
    const orchestrator = new RecordingOrchestrator();
    const { runtime } = runtimeFixture({
      orchestrator,
      config: runtimeConfig({
        recentMessages: 0,
        compactionMessageThreshold: 2,
      }),
    });

    await runtime.chat({
      sessionId: "session-1",
      message: "First",
      user: { userId: "user-1" },
    });
    await runtime.chat({
      sessionId: "session-1",
      message: "Second",
      user: { userId: "user-1" },
    });

    expect(orchestrator.inputs[1]?.memory.recentMessages).toEqual([]);
    expect(orchestrator.inputs[1]?.memory.summary?.summaryText).toContain(
      "USER: First",
    );
    expect(orchestrator.inputs[1]?.memory.summary?.summaryText).toContain(
      "ASSISTANT: answer-1",
    );
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
  });

  it("registers the active turn before compaction and propagates abort", async () => {
    let notifyStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const provider: CompactionProvider = {
      summarize: (_input, signal) =>
        new Promise((_resolve, reject) => {
          notifyStarted();
          const onAbort = (): void => {
            reject(
              new RuntimeError(
                RuntimeErrorCode.ABORTED,
                "The compaction was aborted.",
              ),
            );
          };
          if (signal?.aborted === true) {
            onAbort();
          } else {
            signal?.addEventListener("abort", onAbort, { once: true });
          }
        }),
    };
    const { runtime, store, orchestrator } = runtimeFixture({
      compactionProvider: provider,
    });
    await runTwoTurns(runtime);

    const pending = runtime.chat({
      sessionId: "session-1",
      message: "Third",
      user: { userId: "user-1" },
    });
    await started;
    await expect(runtime.abortSession("session-1")).resolves.toEqual({
      sessionId: "session-1",
      aborted: true,
    });
    await expect(pending).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });

    expect(orchestrator.inputs).toHaveLength(2);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
    expect((await store.loadSessionAggregate("session-1"))?.summary).toBeUndefined();
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });

  it("does not compact a session before verifying ownership", async () => {
    const summarize = vi.fn(() => Promise.resolve(compactedSummary()));
    const { runtime, orchestrator } = runtimeFixture({
      compactionProvider: { summarize },
    });
    await runTwoTurns(runtime);

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Unauthorized",
        user: { userId: "user-2" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.SESSION_NOT_FOUND });
    expect(summarize).not.toHaveBeenCalled();
    expect(orchestrator.inputs).toHaveLength(2);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
  });

  it("commits no new turn when the compaction provider fails", async () => {
    const error = new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      "The compaction provider is unavailable.",
    );
    const { runtime, store, orchestrator } = runtimeFixture({
      compactionProvider: { summarize: () => Promise.reject(error) },
    });
    await runTwoTurns(runtime);

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Third",
        user: { userId: "user-1" },
      }),
    ).rejects.toBe(error);
    expect(orchestrator.inputs).toHaveLength(2);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
    expect((await store.loadSessionAggregate("session-1"))?.summary).toBeUndefined();
  });

  it("commits no new turn when business orchestration fails after maintenance compaction", async () => {
    const error = new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      "The business provider is unavailable.",
    );
    const orchestrator = new FailThirdOrchestrator(error);
    const { runtime, store } = runtimeFixture({
      orchestrator,
      compactionProvider: {
        summarize: () => Promise.resolve(compactedSummary()),
      },
    });
    await runTwoTurns(runtime);

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Third",
        user: { userId: "user-1" },
      }),
    ).rejects.toBe(error);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
    expect((await store.loadSessionAggregate("session-1"))?.summary).toMatchObject({
      summaryText: "The first turn was compacted.",
    });
    expect(store.getCompletedTurns("session-1")).toHaveLength(2);
  });

  it("commits no new turn when compaction hits a revision conflict", async () => {
    const store = new ConflictOnCompactionStore();
    const { runtime, orchestrator } = runtimeFixture({
      store,
      compactionProvider: {
        summarize: () => Promise.resolve(compactedSummary()),
      },
    });
    await runTwoTurns(runtime);

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Third",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.SESSION_CONFLICT });
    expect(orchestrator.inputs).toHaveLength(2);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
  });

  it("revalidates the reloaded aggregate before business orchestration", async () => {
    const store = new InvalidReloadStore();
    const { runtime, orchestrator } = runtimeFixture({
      store,
      compactionProvider: {
        summarize: () => Promise.resolve(compactedSummary()),
      },
    });
    await runTwoTurns(runtime);

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Third",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.CONTEXT_INVALID });
    expect(orchestrator.inputs).toHaveLength(2);
    expect(await runtime.getMessages("session-1")).toHaveLength(4);
  });

  it("runs compaction before streaming orchestration", async () => {
    const order: string[] = [];
    const orchestrator = new RecordingOrchestrator(order);
    const { runtime } = runtimeFixture({
      orchestrator,
      compactionProvider: {
        summarize: () => {
          order.push("compaction");
          return Promise.resolve(compactedSummary());
        },
      },
    });
    await runTwoTurns(runtime);
    order.length = 0;

    const events = await collect(
      runtime.stream({
        sessionId: "session-1",
        message: "Third",
        user: { userId: "user-1" },
      }),
    );

    expect(order).toEqual(["compaction", "business-stream"]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(await runtime.getMessages("session-1")).toHaveLength(6);
  });
});
