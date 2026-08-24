import { describe, expect, it } from "vitest";

import {
  RuntimeError,
  RuntimeErrorCode,
  createTurnSnapshot,
  type BusinessOrchestrator,
  type Clock,
  type CompactionProvider,
  type GuardPort,
  type IdGenerator,
  type OrchestrationInput,
  type OrchestrationResult,
  type RuntimeConfig,
  type RuntimeStore,
  type TelemetryEvent,
  type TelemetryPort,
  type TurnSnapshotInput,
} from "../src/index.js";

const snapshotInput = (): TurnSnapshotInput => ({
  traceId: "trace-1",
  turnId: "turn-1",
  sessionId: "session-1",
  query: "Hello",
  mode: "QUICK",
  context: {
    version: "1.0",
    revision: 0,
    conversation: { topic: "testing" },
    workflow: {
      state: { nested: { steps: [{ done: false }] } },
    },
    runtime: {},
  },
  memory: {
    recentMessages: [
      {
        role: "USER",
        content: "Earlier message",
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    ],
    summary: {
      userGoals: ["verify immutability"],
      confirmedFacts: [],
      unresolvedIssues: [],
      entities: {},
      previousActions: [],
      summaryText: "A test summary.",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
  },
  user: { userId: "user-1", metadata: { locale: "en" } },
  createdAt: "2026-08-20T00:00:01.000Z",
});

describe("core contracts", () => {
  it("defines a provider-neutral orchestrator interface", async () => {
    const result: OrchestrationResult = {
      answer: "Done",
      status: "ANSWER",
      sources: [],
      providerConversationId: "external-1",
    };
    const orchestrator: BusinessOrchestrator = {
      execute: async (_input: OrchestrationInput) => result,
      stream: async function* (_input: OrchestrationInput) {
        yield { type: "completed", result };
      },
    };

    await expect(orchestrator.execute({} as OrchestrationInput)).resolves.toBe(
      result,
    );
    const events = [];
    for await (const event of orchestrator.stream({} as OrchestrationInput)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "completed", result }]);
  });

  it("keeps runtime configuration in canonical execution modes", () => {
    const config = {
      defaultMode: "QUICK",
      recentMessages: 8,
      compactionMessageThreshold: 20,
      compactionTokenThreshold: 12_000,
      quickTimeoutMs: 25_000,
      deepTimeoutMs: 60_000,
      retryAttempts: 1,
      guards: { input: true, output: true },
    } satisfies RuntimeConfig;

    expect(config.defaultMode).toBe("QUICK");
  });

  it("exposes canonical structured runtime errors", () => {
    const error = new RuntimeError(
      RuntimeErrorCode.PROVIDER_RATE_LIMITED,
      "Please retry later.",
      { retryable: true },
    );

    expect(error).toMatchObject({
      name: "RuntimeError",
      code: "PROVIDER_RATE_LIMITED",
      retryable: true,
      message: "Please retry later.",
    });
  });

  it("keeps infrastructure capabilities behind injectable ports", async () => {
    const clock: Clock = {
      now: () => new Date("2026-08-20T00:00:00.000Z"),
      sleep: () => Promise.resolve(),
    };
    const ids: IdGenerator = { generate: () => "generated-id" };
    const guard: GuardPort = {
      evaluate: () =>
        Promise.resolve({
          action: "ALLOW",
          safe: true,
          riskTypes: [],
        }),
    };
    const compaction: CompactionProvider = {
      summarize: () =>
        Promise.resolve({
          userGoals: [],
          confirmedFacts: [],
          unresolvedIssues: [],
          entities: {},
          previousActions: [],
          summaryText: "",
          createdAt: "2026-08-20T00:00:00.000Z",
        }),
    };
    const recorded: TelemetryEvent[] = [];
    const telemetry: TelemetryPort = {
      record: (event) => {
        recorded.push(event);
      },
    };
    const store: RuntimeStore = {
      loadSessionAggregate: () => Promise.resolve(null),
      commitTurn: () => Promise.reject(new Error("not invoked")),
      recordFailedTurn: () => Promise.resolve(),
      resetSession: () => Promise.resolve(),
      commitCompaction: () => Promise.resolve(),
      getSession: () => Promise.resolve(null),
      getMessages: () => Promise.resolve([]),
    };

    telemetry.record({
      name: "turn.tested",
      timestamp: clock.now().toISOString(),
    });

    expect(ids.generate()).toBe("generated-id");
    await expect(
      guard.evaluate({ phase: "INPUT", traceId: "trace-1", text: "Hello" }),
    ).resolves.toMatchObject({ action: "ALLOW" });
    await expect(
      compaction.summarize({ sessionId: "session-1", messages: [] }),
    ).resolves.toMatchObject({ summaryText: "" });
    await expect(store.getMessages("session-1")).resolves.toEqual([]);
    expect(recorded).toHaveLength(1);
  });
});

describe("createTurnSnapshot", () => {
  it("deeply clones and freezes every nested domain value", () => {
    const input = snapshotInput();
    const snapshot = createTurnSnapshot(input);
    const mutableView = snapshot as unknown as {
      context: {
        workflow: {
          state: { nested: { steps: Array<{ done: boolean }> } };
        };
      };
    };

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.context)).toBe(true);
    expect(Object.isFrozen(snapshot.context.workflow.state)).toBe(true);
    expect(Object.isFrozen(snapshot.memory.recentMessages)).toBe(true);
    expect(Object.isFrozen(snapshot.user.metadata)).toBe(true);
    expect(() => {
      mutableView.context.workflow.state.nested.steps[0]!.done = true;
    }).toThrow(TypeError);
  });

  it("does not alias or freeze the aggregate used to create it", () => {
    const input = snapshotInput();
    const snapshot = createTurnSnapshot(input);
    const inputState = input.context.workflow.state as {
      nested: { steps: Array<{ done: boolean }> };
    };
    const snapshotState = snapshot.context.workflow.state as {
      readonly nested: { readonly steps: readonly [{ readonly done: boolean }] };
    };

    inputState.nested.steps[0]!.done = true;

    expect(Object.isFrozen(input)).toBe(false);
    expect(inputState.nested.steps[0]!.done).toBe(true);
    expect(snapshotState.nested.steps[0].done).toBe(false);
  });
});
