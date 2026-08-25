import { describe, expect, it } from "vitest";

import { MockBusinessOrchestrator } from "@skein-chatbot/adapter-mock";
import type { RuntimeEvent } from "@skein-chatbot/contracts";
import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  RuntimeErrorCode,
  createDefaultSkeinContext,
  type RestoreSessionCommand,
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

const restoreCommand = (): RestoreSessionCommand => ({
  session: {
    id: "restored-session",
    userId: "user-1",
    status: "ACTIVE",
    revision: 0,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:03.000Z",
    lastActiveAt: "2026-08-25T00:00:03.000Z",
  },
  context: createDefaultSkeinContext(0),
  messages: [
    {
      id: "history-1-user",
      sessionId: "restored-session",
      role: "USER",
      content: "Earlier question",
      createdAt: "2026-08-25T00:00:01.000Z",
    },
    {
      id: "history-1-assistant",
      sessionId: "restored-session",
      role: "ASSISTANT",
      content: "Earlier answer",
      createdAt: "2026-08-25T00:00:02.000Z",
    },
  ],
  providerBinding: {
    sessionId: "restored-session",
    provider: "provider",
    providerKey: "profile",
    externalConversationId: "external-conversation",
  },
});

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
  it("restores one complete aggregate atomically and clones every input", async () => {
    const store = new InMemoryRuntimeStore();
    const command = restoreCommand();

    await expect(store.restoreSession(command)).resolves.toEqual(
      command.session,
    );
    command.session.userId = "tampered";
    (command.messages[0] as { content: string }).content = "tampered";
    command.providerBinding.externalConversationId = "tampered";

    expect(await store.getMessages("restored-session")).toEqual(
      restoreCommand().messages,
    );
    expect(await store.loadSessionAggregate("restored-session")).toEqual({
      session: restoreCommand().session,
      context: restoreCommand().context,
      messages: restoreCommand().messages,
      providerBindings: [restoreCommand().providerBinding],
    });
  });

  it.each([
    ["duplicate message IDs", (command: RestoreSessionCommand) => {
      (command.messages[1] as { id: string }).id = command.messages[0]!.id;
    }],
    ["wrong message session", (command: RestoreSessionCommand) => {
      (command.messages[0] as { sessionId: string }).sessionId = "other";
    }],
    ["nonchronological messages", (command: RestoreSessionCommand) => {
      (command.messages[0] as { createdAt: string }).createdAt =
        "2026-08-25T00:00:03.000Z";
    }],
    ["nonzero session revision", (command: RestoreSessionCommand) => {
      command.session.revision = 1;
    }],
    ["nondefault context", (command: RestoreSessionCommand) => {
      command.context.conversation.topic = "not-default";
    }],
    ["wrong binding session", (command: RestoreSessionCommand) => {
      command.providerBinding.sessionId = "other";
    }],
  ])("rejects %s without partial state", async (_label, mutate) => {
    const store = new InMemoryRuntimeStore();
    const command = restoreCommand();
    mutate(command);

    await expect(store.restoreSession(command)).rejects.toMatchObject({
      code: RuntimeErrorCode.CONTEXT_INVALID,
    });
    expect(await store.getSession("restored-session")).toBeNull();
    expect(await store.getMessages("restored-session")).toEqual([]);
  });

  it("never overwrites an existing restored session", async () => {
    const store = new InMemoryRuntimeStore();
    const original = restoreCommand();
    await store.restoreSession(original);
    const conflicting = restoreCommand();
    conflicting.session.userId = "other-user";
    conflicting.providerBinding.externalConversationId = "other-external";

    await expect(store.restoreSession(conflicting)).rejects.toMatchObject({
      code: RuntimeErrorCode.SESSION_CONFLICT,
    });
    await expect(store.restoreSession(restoreCommand())).rejects.toMatchObject({
      code: RuntimeErrorCode.SESSION_CONFLICT,
    });
    expect(await store.loadSessionAggregate("restored-session")).toEqual({
      session: original.session,
      context: original.context,
      messages: original.messages,
      providerBindings: [original.providerBinding],
    });
  });

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
