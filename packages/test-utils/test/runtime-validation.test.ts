import { describe, expect, it } from "vitest";

import { MockBusinessOrchestrator } from "@skein-chatbot/adapter-mock";
import type { RuntimeEvent } from "@skein-chatbot/contracts";
import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  RuntimeErrorCode,
} from "@skein-chatbot/core";

import {
  InMemoryRuntimeStore,
  ManualClock,
  SequenceIdGenerator,
} from "../src/index.js";

const runtimeFor = (
  orchestrator: MockBusinessOrchestrator,
  store = new InMemoryRuntimeStore(),
): { runtime: ChatRuntime; store: InMemoryRuntimeStore } => ({
  runtime: new ChatRuntime({
    orchestrator,
    store,
    config: DEFAULT_RUNTIME_CONFIG,
    provider: "provider",
    providerKey: "default",
    clock: new ManualClock(),
    idGenerator: new SequenceIdGenerator(),
  }),
  store,
});

const collect = async (
  iterable: AsyncIterable<RuntimeEvent>,
): Promise<RuntimeEvent[]> => {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

describe("runtime validation with the invalid-result fixture", () => {
  it("rejects an invalid blocking result without committing state", async () => {
    const { runtime, store } = runtimeFor(
      new MockBusinessOrchestrator({ scenario: "invalid-result" }),
    );

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Validate",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
    expect(await store.getSession("session-1")).toBeNull();
    expect(await store.getMessages("session-1")).toEqual([]);
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });

  it("converts an invalid terminal result into exactly one failed event", async () => {
    const { runtime, store } = runtimeFor(
      new MockBusinessOrchestrator({ scenario: "invalid-result" }),
    );
    const events = await collect(
      runtime.stream({
        sessionId: "session-1",
        message: "Validate stream",
        user: { userId: "user-1" },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "turn.completed" || event.type === "turn.failed",
      ),
    ).toHaveLength(1);
    expect(await store.getSession("session-1")).toBeNull();
  });
});

describe("InMemoryRuntimeStore", () => {
  it("clones state at every boundary and commits compaction atomically", async () => {
    const store = new InMemoryRuntimeStore();
    const { runtime } = runtimeFor(
      new MockBusinessOrchestrator({ scenario: "context-patch" }),
      store,
    );
    await runtime.chat({
      sessionId: "session-1",
      message: "Create state",
      user: { userId: "user-1" },
    });
    const first = await store.loadSessionAggregate("session-1");
    expect(first).not.toBeNull();
    const mutableState = first?.context.workflow.state as Record<
      string,
      unknown
    >;
    mutableState.mockState = "tampered";

    expect(
      (await store.loadSessionAggregate("session-1"))?.context.workflow.state,
    ).toEqual({ mockState: "updated" });

    const summary = {
      userGoals: ["retain history"],
      confirmedFacts: [],
      unresolvedIssues: [],
      entities: {},
      previousActions: [],
      summaryText: "A compact summary.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const stored = await store.loadSessionAggregate("session-1");
    await store.commitCompaction({
      sessionId: "session-1",
      expectedRevision: 1,
      summary,
      compactedMessageIds: stored?.messages.map((message) => message.id) ?? [],
      committedAt: "2026-01-01T00:00:01.000Z",
    });
    summary.userGoals[0] = "tampered";

    const compacted = await store.loadSessionAggregate("session-1");
    expect(compacted?.summary?.userGoals).toEqual(["retain history"]);
    expect(compacted?.messages).toEqual([]);
    expect(await store.getMessages("session-1")).toHaveLength(2);
    expect(compacted?.context.revision).toBe(1);

    await runtime.chat({
      sessionId: "session-1",
      message: "Add active history",
      user: { userId: "user-1" },
    });
    const active = await store.loadSessionAggregate("session-1");
    expect(active?.messages).toHaveLength(2);
    await store.commitCompaction({
      sessionId: "session-1",
      expectedRevision: 2,
      summary: {
        ...summary,
        userGoals: ["retain all history"],
      },
      compactedMessageIds: active?.messages.map((message) => message.id) ?? [],
      committedAt: "2026-01-01T00:00:02.000Z",
    });

    expect((await store.loadSessionAggregate("session-1"))?.messages).toEqual(
      [],
    );
    expect(await store.getMessages("session-1")).toHaveLength(4);
  });
});
