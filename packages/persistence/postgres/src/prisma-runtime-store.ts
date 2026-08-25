import {
  createDefaultSkeinContext,
  type CanonicalMessage,
  type CommitTurnCommand,
  type CommitTurnResult,
  type CompactionCommitCommand,
  type FailedTurnCommand,
  type ResetSessionCommand,
  type RestoreSessionCommand,
  type RuntimeSession,
  type RuntimeStore,
  type SessionAggregate,
  validateRestoreSessionCommand,
} from "@skein-chatbot/core";

import {
  commandDate,
  encodeConversationSummary,
  encodeSkeinContext,
  parseCanonicalMessage,
  parseConversationSummary,
  parseDatabaseDate,
  parseProviderBinding,
  parseRuntimeSession,
  parseSkeinContext,
  requireNonNegativeInt,
  requireRecord,
  requireString,
} from "./domain-codec.js";
import {
  createContextInvalidError,
  createDatabaseError,
  createSessionConflictError,
  mapPrismaError,
} from "./persistence-errors.js";
import {
  assertPrismaRuntimeClient,
  type PrismaRuntimeClient,
} from "./prisma-client-protocol.js";

const completedStatuses: ReadonlySet<string> = new Set([
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
]);

const executionModes: ReadonlySet<string> = new Set(["QUICK", "DEEP"]);

const countFrom = (value: unknown, operation: string): number => {
  const result = requireRecord(value, operation);
  const count = result["count"];
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw createDatabaseError(new TypeError(`${operation} returned no count.`));
  }
  return count as number;
};

const optionalArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw createDatabaseError(new TypeError(`${label} is not an array.`));
  }
  return value;
};

const assertSessionId = (actual: string, expected: string): void => {
  if (actual !== expected) {
    throw createDatabaseError(
      new TypeError("Stored aggregate contains a mismatched session ID."),
    );
  }
};

const aggregateFromRow = (value: unknown): SessionAggregate => {
  const row = requireRecord(value, "Session");
  const contextState = requireRecord(row["contextState"], "ContextState");
  const session = parseRuntimeSession(row, contextState);
  const context = parseSkeinContext(contextState["value"]);
  if (
    context.revision !== session.revision ||
    contextState["sessionId"] !== session.id
  ) {
    throw createDatabaseError(
      new TypeError("Stored context revision or session ID is inconsistent."),
    );
  }

  const messages = optionalArray(row["messages"], "messages").map((message) => {
    const parsed = parseCanonicalMessage(message);
    assertSessionId(parsed.sessionId, session.id);
    return parsed;
  });
  const providerBindings = optionalArray(
    row["providerBindings"],
    "providerBindings",
  ).map((binding) => {
    const parsed = parseProviderBinding(binding);
    assertSessionId(parsed.sessionId, session.id);
    return parsed;
  });

  const summaryValue = row["conversationSummary"];
  return {
    session,
    context,
    messages,
    providerBindings,
    ...(summaryValue === null || summaryValue === undefined
      ? {}
      : {
          summary: parseConversationSummary(
            requireRecord(summaryValue, "ConversationSummary")["value"],
          ),
        }),
  };
};

const assertMessage = (
  message: CanonicalMessage,
  sessionId: string,
  role: "USER" | "ASSISTANT",
): void => {
  requireString(message.id, `${role} message ID`);
  if (
    message.sessionId !== sessionId ||
    message.role !== role ||
    typeof message.content !== "string"
  ) {
    throw createContextInvalidError();
  }
  commandDate(message.createdAt, `${role} message createdAt`);
};

const validateCommit = (command: CommitTurnCommand): void => {
  const sessionId = requireString(command.sessionId, "session ID");
  requireString(command.userId, "user ID");
  const expectedRevision = requireNonNegativeInt(
    command.expectedRevision,
    "expected revision",
  );
  requireString(command.turn.traceId, "trace ID");
  requireString(command.turn.turnId, "turn ID");
  requireString(command.turn.provider, "provider");
  requireString(command.turn.providerKey, "provider key");
  requireNonNegativeInt(command.turn.latencyMs, "latency");
  const startedAt = commandDate(command.turn.startedAt, "turn startedAt");
  const completedAt = commandDate(
    command.turn.completedAt,
    "turn completedAt",
  );

  if (
    expectedRevision >= 2_147_483_647 ||
    completedAt.getTime() < startedAt.getTime() ||
    command.turn.sessionId !== sessionId ||
    !executionModes.has(command.turn.mode) ||
    !completedStatuses.has(command.turn.status) ||
    command.nextContext.revision !== command.expectedRevision + 1
  ) {
    throw createContextInvalidError();
  }
  assertMessage(command.userMessage, sessionId, "USER");
  assertMessage(command.assistantMessage, sessionId, "ASSISTANT");
  if (command.userMessage.id === command.assistantMessage.id) {
    throw createSessionConflictError();
  }
  encodeSkeinContext(command.nextContext);

  const binding = command.providerBinding;
  if (
    binding !== undefined &&
    (binding.sessionId !== sessionId ||
      requireString(binding.provider, "binding provider") !==
        command.turn.provider ||
      requireString(binding.providerKey, "binding provider key") !==
        command.turn.providerKey ||
      typeof binding.externalConversationId !== "string" ||
      binding.externalConversationId.length === 0)
  ) {
    throw createContextInvalidError();
  }
};

const sessionSelect = {
  id: true,
  userId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lastActiveAt: true,
  contextState: true,
} as const;

export class PrismaRuntimeStore implements RuntimeStore {
  private readonly client: PrismaRuntimeClient;

  constructor(client: unknown) {
    assertPrismaRuntimeClient(client);
    this.client = client;
  }

  async loadSessionAggregate(
    sessionId: string,
  ): Promise<SessionAggregate | null> {
    requireString(sessionId, "session ID");
    try {
      const value = await this.client.session.findUnique({
        where: { id: sessionId },
        include: {
          contextState: true,
          messages: {
            where: { compactedAt: null },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
          conversationSummary: true,
          providerBindings: {
            orderBy: [{ provider: "asc" }, { providerKey: "asc" }],
          },
        },
      });
      return value === null ? null : aggregateFromRow(value);
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async restoreSession(command: RestoreSessionCommand): Promise<RuntimeSession> {
    validateRestoreSessionCommand(command);
    const contextValue = encodeSkeinContext(command.context);
    const createdAt = commandDate(command.session.createdAt, "session createdAt");
    const updatedAt = commandDate(command.session.updatedAt, "session updatedAt");
    const lastActiveAt = commandDate(
      command.session.lastActiveAt,
      "session lastActiveAt",
    );
    const messages = command.messages.map((message) => ({
      id: message.id,
      sessionId: command.session.id,
      role: message.role,
      content: message.content,
      createdAt: commandDate(message.createdAt, "message createdAt"),
    }));

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.session.create({
          data: {
            id: command.session.id,
            userId: command.session.userId,
            status: "ACTIVE",
            createdAt,
            updatedAt,
            lastActiveAt,
          },
        });
        await transaction.contextState.create({
          data: {
            sessionId: command.session.id,
            revision: 0,
            value: contextValue,
            updatedAt,
          },
        });
        if (messages.length > 0) {
          const messageCount = countFrom(
            await transaction.message.createMany({ data: messages }),
            "Message.createMany",
          );
          if (messageCount !== messages.length) {
            throw createDatabaseError(
              new Error("The restore transaction did not insert every message."),
            );
          }
        }
        const binding = command.providerBinding;
        await transaction.providerBinding.upsert({
          where: {
            sessionId_provider_providerKey: {
              sessionId: command.session.id,
              provider: binding.provider,
              providerKey: binding.providerKey,
            },
          },
          create: {
            sessionId: command.session.id,
            provider: binding.provider,
            providerKey: binding.providerKey,
            externalConversationId: binding.externalConversationId,
            createdAt: updatedAt,
            updatedAt,
          },
          update: {
            externalConversationId: binding.externalConversationId,
            updatedAt,
          },
        });
      });
      return structuredClone(command.session);
    } catch (error) {
      throw mapPrismaError(error, { optimisticConflict: true });
    }
  }

  async commitTurn(command: CommitTurnCommand): Promise<CommitTurnResult> {
    validateCommit(command);
    const nextContextValue = encodeSkeinContext(command.nextContext);
    const startedAt = commandDate(command.turn.startedAt, "turn startedAt");
    const completedAt = commandDate(
      command.turn.completedAt,
      "turn completedAt",
    );

    try {
      return await this.client.$transaction(async (transaction) => {
        const existingValue = await transaction.session.findUnique({
          where: { id: command.sessionId },
          select: {
            id: true,
            userId: true,
            createdAt: true,
          },
        });

        let createdAt = startedAt;
        if (existingValue === null) {
          if (command.expectedRevision !== 0) {
            throw createSessionConflictError();
          }
          await transaction.session.create({
            data: {
              id: command.sessionId,
              userId: command.userId,
              status: "ACTIVE",
              createdAt: startedAt,
              updatedAt: completedAt,
              lastActiveAt: completedAt,
            },
          });
          await transaction.contextState.create({
            data: {
              sessionId: command.sessionId,
              revision: command.nextContext.revision,
              value: nextContextValue,
              updatedAt: completedAt,
            },
          });
        } else {
          const existing = requireRecord(existingValue, "Session");
          if (existing["userId"] !== command.userId) {
            throw createSessionConflictError();
          }
          const storedCreatedAt = existing["createdAt"];
          createdAt = new Date(
            parseDatabaseDate(storedCreatedAt, "stored session createdAt"),
          );
          const claimed = countFrom(
            await transaction.contextState.updateMany({
              where: {
                sessionId: command.sessionId,
                revision: command.expectedRevision,
              },
              data: {
                revision: command.nextContext.revision,
                value: nextContextValue,
                updatedAt: completedAt,
              },
            }),
            "ContextState.updateMany",
          );
          if (claimed !== 1) {
            throw createSessionConflictError();
          }
        }

        await transaction.session.update({
          where: { id: command.sessionId },
          data: {
            status: "ACTIVE",
            updatedAt: completedAt,
            lastActiveAt: completedAt,
          },
        });

        const messageCount = countFrom(
          await transaction.message.createMany({
            data: [
              {
                id: command.userMessage.id,
                sessionId: command.sessionId,
                role: "USER",
                content: command.userMessage.content,
                createdAt: commandDate(
                  command.userMessage.createdAt,
                  "user message createdAt",
                ),
              },
              {
                id: command.assistantMessage.id,
                sessionId: command.sessionId,
                role: "ASSISTANT",
                content: command.assistantMessage.content,
                createdAt: commandDate(
                  command.assistantMessage.createdAt,
                  "assistant message createdAt",
                ),
              },
            ],
          }),
          "Message.createMany",
        );
        if (messageCount !== 2) {
          throw createDatabaseError(
            new Error("The message transaction did not insert two rows."),
          );
        }

        await transaction.turn.create({
          data: {
            turnId: command.turn.turnId,
            sessionId: command.sessionId,
            traceId: command.turn.traceId,
            mode: command.turn.mode,
            provider: command.turn.provider,
            providerKey: command.turn.providerKey,
            status: command.turn.status,
            startedAt,
            completedAt,
            latencyMs: command.turn.latencyMs,
          },
        });

        if (command.providerBinding !== undefined) {
          const binding = command.providerBinding;
          await transaction.providerBinding.upsert({
            where: {
              sessionId_provider_providerKey: {
                sessionId: command.sessionId,
                provider: binding.provider,
                providerKey: binding.providerKey,
              },
            },
            create: {
              sessionId: command.sessionId,
              provider: binding.provider,
              providerKey: binding.providerKey,
              externalConversationId: binding.externalConversationId,
              createdAt: completedAt,
              updatedAt: completedAt,
            },
            update: {
              externalConversationId: binding.externalConversationId,
              updatedAt: completedAt,
            },
          });
        }

        return {
          session: {
            id: command.sessionId,
            userId: command.userId,
            status: "ACTIVE",
            revision: command.nextContext.revision,
            createdAt: createdAt.toISOString(),
            updatedAt: completedAt.toISOString(),
            lastActiveAt: completedAt.toISOString(),
          },
          context: structuredClone(command.nextContext),
        };
      });
    } catch (error) {
      throw mapPrismaError(error, { optimisticConflict: true });
    }
  }

  async recordFailedTurn(command: FailedTurnCommand): Promise<void> {
    requireString(command.traceId, "trace ID");
    requireString(command.turnId, "turn ID");
    requireString(command.sessionId, "session ID");
    requireString(command.provider, "provider");
    requireString(command.providerKey, "provider key");
    requireString(command.errorCode, "error code");
    requireNonNegativeInt(command.latencyMs, "latency");
    if (!executionModes.has(command.mode)) {
      throw createContextInvalidError();
    }

    try {
      await this.client.turn.create({
        data: {
          turnId: command.turnId,
          sessionId: command.sessionId,
          traceId: command.traceId,
          mode: command.mode,
          provider: command.provider,
          providerKey: command.providerKey,
          status: "FAILED",
          startedAt: commandDate(command.startedAt, "turn startedAt"),
          completedAt: commandDate(command.failedAt, "turn failedAt"),
          latencyMs: command.latencyMs,
          errorCode: command.errorCode,
        },
      });
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async resetSession(command: ResetSessionCommand): Promise<void> {
    requireString(command.sessionId, "session ID");
    const expectedRevision = requireNonNegativeInt(
      command.expectedRevision,
      "expected revision",
    );
    if (expectedRevision >= 2_147_483_647) {
      throw createContextInvalidError();
    }
    const resetAt = commandDate(command.resetAt, "resetAt");
    const nextRevision = expectedRevision + 1;
    const nextContext = createDefaultSkeinContext(nextRevision);
    nextContext.runtime.updatedAt = resetAt.toISOString();

    try {
      await this.client.$transaction(async (transaction) => {
        const claimed = countFrom(
          await transaction.contextState.updateMany({
            where: {
              sessionId: command.sessionId,
              revision: command.expectedRevision,
            },
            data: {
              revision: nextRevision,
              value: encodeSkeinContext(nextContext),
              updatedAt: resetAt,
            },
          }),
          "ContextState.updateMany",
        );
        if (claimed !== 1) {
          throw createSessionConflictError();
        }

        await transaction.message.deleteMany({
          where: { sessionId: command.sessionId },
        });
        await transaction.providerBinding.deleteMany({
          where: { sessionId: command.sessionId },
        });
        await transaction.conversationSummary.deleteMany({
          where: { sessionId: command.sessionId },
        });
        await transaction.session.update({
          where: { id: command.sessionId },
          data: {
            status: "RESET",
            updatedAt: resetAt,
            lastActiveAt: resetAt,
          },
        });
      });
    } catch (error) {
      throw mapPrismaError(error, { optimisticConflict: true });
    }
  }

  async commitCompaction(command: CompactionCommitCommand): Promise<void> {
    requireString(command.sessionId, "session ID");
    requireNonNegativeInt(command.expectedRevision, "expected revision");
    const committedAt = commandDate(command.committedAt, "committedAt");
    const summaryValue = encodeConversationSummary(command.summary);
    const summaryCreatedAt = commandDate(
      command.summary.createdAt,
      "summary createdAt",
    );
    const messageIds = [...new Set(command.compactedMessageIds)];
    for (const messageId of messageIds) {
      requireString(messageId, "compacted message ID");
    }

    try {
      await this.client.$transaction(async (transaction) => {
        const claimed = countFrom(
          await transaction.contextState.updateMany({
            where: {
              sessionId: command.sessionId,
              revision: command.expectedRevision,
            },
            data: { updatedAt: committedAt },
          }),
          "ContextState.updateMany",
        );
        if (claimed !== 1) {
          throw createSessionConflictError();
        }

        if (messageIds.length > 0) {
          const matchingValue = await transaction.message.findMany({
            where: {
              sessionId: command.sessionId,
              id: { in: messageIds },
            },
            select: { id: true },
          });
          const matching = optionalArray(matchingValue, "messages");
          if (matching.length !== messageIds.length) {
            throw createContextInvalidError();
          }
          const updated = countFrom(
            await transaction.message.updateMany({
              where: {
                sessionId: command.sessionId,
                id: { in: messageIds },
                compactedAt: null,
              },
              data: { compactedAt: committedAt },
            }),
            "Message.updateMany",
          );
          if (updated !== messageIds.length) {
            throw createSessionConflictError();
          }
        }

        await transaction.conversationSummary.upsert({
          where: { sessionId: command.sessionId },
          create: {
            sessionId: command.sessionId,
            value: summaryValue,
            createdAt: summaryCreatedAt,
            updatedAt: committedAt,
          },
          update: {
            value: summaryValue,
            updatedAt: committedAt,
          },
        });
      });
    } catch (error) {
      throw mapPrismaError(error, { optimisticConflict: true });
    }
  }

  async getSession(sessionId: string): Promise<RuntimeSession | null> {
    requireString(sessionId, "session ID");
    try {
      const value = await this.client.session.findUnique({
        where: { id: sessionId },
        select: sessionSelect,
      });
      return value === null ? null : parseRuntimeSession(value);
    } catch (error) {
      throw mapPrismaError(error);
    }
  }

  async getMessages(
    sessionId: string,
  ): Promise<readonly CanonicalMessage[]> {
    requireString(sessionId, "session ID");
    try {
      const value = await this.client.message.findMany({
        where: { sessionId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return optionalArray(value, "messages").map(parseCanonicalMessage);
    } catch (error) {
      throw mapPrismaError(error);
    }
  }
}
