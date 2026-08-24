import { randomUUID } from "node:crypto";

import {
  createDefaultSkeinContext,
  type CommitTurnCommand,
  type ConversationSummary,
} from "@skein-chatbot/core";

import { createPostgresRuntimeStore } from "../src/postgres-client.js";

const databaseUrl = process.env["SKEIN_POSTGRES_TEST_URL"];
const confirmation = process.env["SKEIN_POSTGRES_TEST_CONFIRM"];
const expectedDatabase = "skein_chatbot_test";

if (databaseUrl === undefined || confirmation !== expectedDatabase) {
  console.log(
    "NOT RUN: set SKEIN_POSTGRES_TEST_URL and SKEIN_POSTGRES_TEST_CONFIRM=skein_chatbot_test for the pre-provisioned dedicated test database.",
  );
  process.exit(0);
}

const sessionId = `postgres-restart-${randomUUID()}`;
const startedAt = new Date().toISOString();
const completedAt = new Date(Date.now() + 10).toISOString();
const context = createDefaultSkeinContext(1);
context.conversation.topic = "restart persistence";
context.workflow.state = { smoke: "persisted" };
context.runtime.lastTurnId = `turn-${sessionId}`;
context.runtime.updatedAt = completedAt;

const command: CommitTurnCommand = {
  sessionId,
  userId: "postgres-restart-smoke",
  expectedRevision: 0,
  turn: {
    traceId: `trace-${sessionId}`,
    turnId: `turn-${sessionId}`,
    sessionId,
    mode: "QUICK",
    provider: "smoke-provider",
    providerKey: "smoke-profile",
    status: "ANSWER",
    startedAt,
    completedAt,
    latencyMs: 10,
  },
  userMessage: {
    id: `user-${sessionId}`,
    sessionId,
    role: "USER",
    content: "Persist this turn.",
    createdAt: startedAt,
  },
  assistantMessage: {
    id: `assistant-${sessionId}`,
    sessionId,
    role: "ASSISTANT",
    content: "This turn is persisted.",
    createdAt: completedAt,
  },
  nextContext: context,
  providerBinding: {
    sessionId,
    provider: "smoke-provider",
    providerKey: "smoke-profile",
    externalConversationId: `external-${sessionId}`,
  },
};

const summary: ConversationSummary = {
  topic: "restart persistence",
  userGoals: ["verify restart"],
  confirmedFacts: ["first client committed"],
  unresolvedIssues: [],
  entities: {},
  previousActions: ["commit turn"],
  summaryText: "A restart persistence smoke record.",
  createdAt: completedAt,
};

const first = await createPostgresRuntimeStore({
  databaseUrl,
  allowedDatabaseNames: [expectedDatabase],
});
try {
  await first.store.commitTurn(command);
  await first.store.commitCompaction({
    sessionId,
    expectedRevision: 1,
    summary,
    compactedMessageIds: [command.userMessage.id],
    committedAt: new Date(Date.now() + 20).toISOString(),
  });
} finally {
  await first.disconnect();
}

const second = await createPostgresRuntimeStore({
  databaseUrl,
  allowedDatabaseNames: [expectedDatabase],
});
try {
  const aggregate = await second.store.loadSessionAggregate(sessionId);
  if (
    aggregate === null ||
    aggregate.session.revision !== 1 ||
    aggregate.messages.length !== 1 ||
    (await second.store.getMessages(sessionId)).length !== 2 ||
    aggregate.context.workflow.state["smoke"] !== "persisted" ||
    aggregate.summary?.summaryText !== summary.summaryText ||
    aggregate.providerBindings[0]?.externalConversationId !==
      command.providerBinding?.externalConversationId
  ) {
    throw new Error("Restart persistence verification failed.");
  }
  console.log(
    `PASS: session ${sessionId} preserved messages, context, summary, and provider binding across a new Prisma client.`,
  );
} finally {
  await second.disconnect();
}
