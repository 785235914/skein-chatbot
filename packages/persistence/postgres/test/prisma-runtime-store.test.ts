import { describe, expect, it } from "vitest";

import {
  RuntimeErrorCode,
  createDefaultSkeinContext,
  type CommitTurnCommand,
  type ConversationSummary,
  type RestoreSessionCommand,
} from "@skein-chatbot/core";

import { PrismaRuntimeStore } from "../src/prisma-runtime-store.js";
import { FakePrismaClient } from "./fake-prisma-client.js";

const startedAt = "2026-08-20T01:00:00.000Z";
const completedAt = "2026-08-20T01:00:00.025Z";

const commandFor = (
  expectedRevision = 0,
  suffix = "1",
): CommitTurnCommand => {
  const nextContext = createDefaultSkeinContext(expectedRevision + 1);
  nextContext.conversation.topic = `topic-${suffix}`;
  nextContext.workflow.state = { step: suffix };
  nextContext.runtime.lastTurnId = `turn-${suffix}`;
  nextContext.runtime.updatedAt = completedAt;
  return {
    sessionId: "session-1",
    userId: "user-1",
    expectedRevision,
    turn: {
      traceId: `trace-${suffix}`,
      turnId: `turn-${suffix}`,
      sessionId: "session-1",
      mode: "QUICK",
      provider: "provider",
      providerKey: "profile",
      status: "ANSWER",
      startedAt,
      completedAt,
      latencyMs: 25,
    },
    userMessage: {
      id: `user-message-${suffix}`,
      sessionId: "session-1",
      role: "USER",
      content: `question-${suffix}`,
      createdAt: startedAt,
    },
    assistantMessage: {
      id: `assistant-message-${suffix}`,
      sessionId: "session-1",
      role: "ASSISTANT",
      content: `answer-${suffix}`,
      createdAt: completedAt,
    },
    nextContext,
    providerBinding: {
      sessionId: "session-1",
      provider: "provider",
      providerKey: "profile",
      externalConversationId: `external-${suffix}`,
    },
  };
};

const summary: ConversationSummary = {
  topic: "topic-1",
  userGoals: ["persist state"],
  confirmedFacts: ["turn committed"],
  unresolvedIssues: [],
  entities: { session: "one" },
  previousActions: ["answer"],
  summaryText: "A persisted summary.",
  createdAt: "2026-08-20T01:01:00.000Z",
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

describe("PrismaRuntimeStore", () => {
  it("restores a complete aggregate across repository instances", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = restoreCommand();

    await expect(store.restoreSession(command)).resolves.toEqual(
      command.session,
    );

    const restarted = new PrismaRuntimeStore(client);
    expect(await restarted.loadSessionAggregate("restored-session")).toEqual({
      session: command.session,
      context: command.context,
      messages: command.messages,
      providerBindings: [command.providerBinding],
    });
    expect(client.inspect()).toMatchObject({
      sessions: 1,
      messages: 2,
      bindings: 1,
    });
    expect(client.inspect().turns).toEqual([]);
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
    ["nonzero context revision", (command: RestoreSessionCommand) => {
      command.context.revision = 1;
    }],
    ["nondefault context", (command: RestoreSessionCommand) => {
      command.context.runtime.updatedAt = "2026-08-25T00:00:00.000Z";
    }],
    ["wrong binding session", (command: RestoreSessionCommand) => {
      command.providerBinding.sessionId = "other";
    }],
  ])("rejects restore %s before database mutation", async (_label, mutate) => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = restoreCommand();
    mutate(command);

    await expect(store.restoreSession(command)).rejects.toMatchObject({
      code: RuntimeErrorCode.CONTEXT_INVALID,
    });
    expect(client.inspect()).toMatchObject({
      sessions: 0,
      messages: 0,
      bindings: 0,
    });
  });

  it("rolls back the whole restore when a later write fails", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    client.failNext(
      "providerBinding.upsert",
      Object.assign(new Error("offline"), { code: "P1001" }),
    );

    await expect(store.restoreSession(restoreCommand())).rejects.toMatchObject({
      code: RuntimeErrorCode.DATABASE_ERROR,
    });
    expect(client.inspect()).toMatchObject({
      sessions: 0,
      messages: 0,
      bindings: 0,
    });
  });

  it("maps every existing-session restore to SESSION_CONFLICT without overwrite", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
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

  it("persists the complete aggregate across repository instances", async () => {
    const client = new FakePrismaClient();
    const first = new PrismaRuntimeStore(client);
    const result = await first.commitTurn(commandFor());

    expect(result.session).toMatchObject({
      id: "session-1",
      userId: "user-1",
      revision: 1,
      status: "ACTIVE",
    });

    const restarted = new PrismaRuntimeStore(client);
    const aggregate = await restarted.loadSessionAggregate("session-1");
    expect(aggregate).toMatchObject({
      session: { revision: 1, userId: "user-1" },
      context: {
        revision: 1,
        conversation: { topic: "topic-1" },
        workflow: { state: { step: "1" } },
      },
      providerBindings: [
        {
          provider: "provider",
          providerKey: "profile",
          externalConversationId: "external-1",
        },
      ],
    });
    expect(aggregate?.messages.map((message) => message.role)).toEqual([
      "USER",
      "ASSISTANT",
    ]);
    expect(client.inspect().turns).toHaveLength(1);
  });

  it("atomically rejects stale revisions without overwriting state", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    await store.commitTurn(commandFor());

    await expect(store.commitTurn(commandFor(0, "stale"))).rejects.toMatchObject({
      code: RuntimeErrorCode.SESSION_CONFLICT,
      retryable: true,
    });
    const aggregate = await store.loadSessionAggregate("session-1");
    expect(aggregate?.session.revision).toBe(1);
    expect(aggregate?.messages).toHaveLength(2);
    expect(aggregate?.providerBindings[0]?.externalConversationId).toBe(
      "external-1",
    );
    expect(client.inspect().turns).toHaveLength(1);
  });

  it("updates the binding in the same transaction as a later turn", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    await store.commitTurn(commandFor());
    await store.commitTurn(commandFor(1, "2"));

    const aggregate = await store.loadSessionAggregate("session-1");
    expect(aggregate?.session.revision).toBe(2);
    expect(aggregate?.messages).toHaveLength(4);
    expect(aggregate?.providerBindings).toEqual([
      {
        sessionId: "session-1",
        provider: "provider",
        providerKey: "profile",
        externalConversationId: "external-2",
      },
    ]);
  });

  it("rolls back a new aggregate when a later transaction write fails", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    client.failNext("turn.create", Object.assign(new Error("offline"), { code: "P1001" }));

    await expect(store.commitTurn(commandFor())).rejects.toMatchObject({
      code: RuntimeErrorCode.DATABASE_ERROR,
      retryable: true,
    });
    expect(await store.loadSessionAggregate("session-1")).toBeNull();
    expect(client.inspect()).toMatchObject({
      sessions: 0,
      messages: 0,
      bindings: 0,
      summaries: 0,
    });
    expect(client.inspect().turns).toHaveLength(0);
  });

  it("persists compaction summary without changing the context revision", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = commandFor();
    await store.commitTurn(command);
    await store.commitCompaction({
      sessionId: "session-1",
      expectedRevision: 1,
      summary,
      compactedMessageIds: [command.userMessage.id, command.assistantMessage.id],
      committedAt: "2026-08-20T01:02:00.000Z",
    });

    const restarted = new PrismaRuntimeStore(client);
    const aggregate = await restarted.loadSessionAggregate("session-1");
    expect(aggregate?.summary).toEqual(summary);
    expect(aggregate?.context.revision).toBe(1);
    expect(aggregate?.messages).toHaveLength(0);
    expect(await restarted.getMessages("session-1")).toHaveLength(2);
  });

  it("accepts exactly one concurrent compaction for the same messages", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = commandFor();
    await store.commitTurn(command);
    const compaction = {
      sessionId: "session-1",
      expectedRevision: 1,
      summary,
      compactedMessageIds: [command.userMessage.id, command.assistantMessage.id],
      committedAt: "2026-08-20T01:02:00.000Z",
    } as const;

    const results = await Promise.allSettled([
      store.commitCompaction(compaction),
      store.commitCompaction(compaction),
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
    expect((await store.getSession("session-1"))?.revision).toBe(1);
    expect(await store.getMessages("session-1")).toHaveLength(2);
  });

  it("rejects compaction IDs outside the session and rolls back the summary", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    await store.commitTurn(commandFor());

    await expect(
      store.commitCompaction({
        sessionId: "session-1",
        expectedRevision: 1,
        summary,
        compactedMessageIds: ["not-a-message"],
        committedAt: "2026-08-20T01:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.CONTEXT_INVALID });
    expect((await store.loadSessionAggregate("session-1"))?.summary).toBeUndefined();
  });

  it("resets context, messages, summary and bindings atomically", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = commandFor();
    await store.commitTurn(command);
    await store.commitCompaction({
      sessionId: "session-1",
      expectedRevision: 1,
      summary,
      compactedMessageIds: [command.userMessage.id],
      committedAt: "2026-08-20T01:02:00.000Z",
    });
    await store.resetSession({
      sessionId: "session-1",
      expectedRevision: 1,
      resetAt: "2026-08-20T01:03:00.000Z",
    });

    const aggregate = await store.loadSessionAggregate("session-1");
    expect(aggregate).toMatchObject({
      session: { status: "RESET", revision: 2 },
      context: {
        version: "1.0",
        revision: 2,
        conversation: {},
        workflow: { state: {} },
        runtime: { updatedAt: "2026-08-20T01:03:00.000Z" },
      },
      messages: [],
      providerBindings: [],
    });
    expect(aggregate?.summary).toBeUndefined();
    expect(client.inspect().turns).toHaveLength(1);
  });

  it("records a failed turn without creating a session aggregate", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    await store.recordFailedTurn({
      traceId: "failed-trace",
      turnId: "failed-turn",
      sessionId: "missing-session",
      mode: "DEEP",
      provider: "provider",
      providerKey: "profile",
      errorCode: RuntimeErrorCode.PROVIDER_TIMEOUT,
      startedAt,
      failedAt: completedAt,
      latencyMs: 25,
    });

    expect(await store.getSession("missing-session")).toBeNull();
    expect(client.inspect().turns).toEqual([
      expect.objectContaining({
        status: "FAILED",
        errorCode: RuntimeErrorCode.PROVIDER_TIMEOUT,
      }),
    ]);
  });

  it("maps connection failures to a retryable database error", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    client.failNext(
      "session.findUnique",
      Object.assign(new Error("private database detail"), { code: "P1001" }),
    );

    await expect(store.getSession("session-1")).rejects.toMatchObject({
      code: RuntimeErrorCode.DATABASE_ERROR,
      message: "The session store operation failed.",
      retryable: true,
    });
  });

  it("rejects a provider binding outside its turn namespace before I/O", async () => {
    const client = new FakePrismaClient();
    const store = new PrismaRuntimeStore(client);
    const command = commandFor();
    if (command.providerBinding !== undefined) {
      command.providerBinding.providerKey = "different-profile";
    }

    await expect(store.commitTurn(command)).rejects.toMatchObject({
      code: RuntimeErrorCode.CONTEXT_INVALID,
    });
    expect(client.inspect().sessions).toBe(0);
  });

  it("accepts 191-character provider keys and rejects 192 before I/O", async () => {
    const acceptedClient = new FakePrismaClient();
    const acceptedStore = new PrismaRuntimeStore(acceptedClient);
    const accepted = commandFor();
    accepted.turn.providerKey = "k".repeat(191);
    if (accepted.providerBinding !== undefined) {
      accepted.providerBinding.providerKey = "k".repeat(191);
    }

    await expect(acceptedStore.commitTurn(accepted)).resolves.toBeDefined();
    expect(
      (await acceptedStore.loadSessionAggregate("session-1"))
        ?.providerBindings[0]?.providerKey,
    ).toHaveLength(191);

    const rejectedClient = new FakePrismaClient();
    const rejectedStore = new PrismaRuntimeStore(rejectedClient);
    const rejected = commandFor();
    rejected.turn.providerKey = "k".repeat(192);
    if (rejected.providerBinding !== undefined) {
      rejected.providerBinding.providerKey = "k".repeat(192);
    }

    await expect(rejectedStore.commitTurn(rejected)).rejects.toMatchObject({
      code: RuntimeErrorCode.CONTEXT_INVALID,
    });
    expect(rejectedClient.inspect().sessions).toBe(0);
  });
});
