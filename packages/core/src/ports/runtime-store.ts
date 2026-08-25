import type { ExecutionMode, MessageRole } from "@skein-chatbot/contracts";

import type { SkeinContext } from "../context/context.js";
import {
  RuntimeError,
  RuntimeErrorCode,
} from "../errors/runtime-error.js";
import type { ConversationSummary } from "../memory/memory.js";
import type { OrchestrationStatus } from "../orchestration/orchestration.js";

export type RuntimeSessionStatus = "ACTIVE" | "RESET";

export interface RuntimeSession {
  id: string;
  userId: string;
  status: RuntimeSessionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface CanonicalMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ProviderConversationBinding {
  sessionId: string;
  provider: string;
  providerKey: string;
  externalConversationId: string;
}

export interface SessionAggregate {
  session: RuntimeSession;
  context: SkeinContext;
  messages: readonly CanonicalMessage[];
  summary?: ConversationSummary;
  providerBindings: readonly ProviderConversationBinding[];
}

export interface CompletedTurnRecord {
  traceId: string;
  turnId: string;
  sessionId: string;
  mode: ExecutionMode;
  provider: string;
  providerKey: string;
  status: OrchestrationStatus;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
}

export interface CommitTurnCommand {
  sessionId: string;
  userId: string;
  expectedRevision: number;
  turn: CompletedTurnRecord;
  userMessage: CanonicalMessage;
  assistantMessage: CanonicalMessage;
  nextContext: SkeinContext;
  providerBinding?: ProviderConversationBinding;
}

export interface CommitTurnResult {
  session: RuntimeSession;
  context: SkeinContext;
}

export interface FailedTurnCommand {
  traceId: string;
  turnId: string;
  sessionId: string;
  mode: ExecutionMode;
  provider: string;
  providerKey: string;
  errorCode: RuntimeErrorCode;
  startedAt: string;
  failedAt: string;
  latencyMs: number;
}

export interface ResetSessionCommand {
  sessionId: string;
  expectedRevision: number;
  resetAt: string;
}

export interface RestoreSessionCommand {
  session: RuntimeSession;
  context: SkeinContext;
  messages: readonly CanonicalMessage[];
  providerBinding: ProviderConversationBinding;
}

const invalidRestoreCommand = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.CONTEXT_INVALID,
    "The restored session state is invalid.",
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const validDurableString = (value: unknown, maximum = 191): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const timestampOf = (value: unknown): number => {
  if (typeof value !== "string") {
    throw invalidRestoreCommand();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidRestoreCommand();
  }
  return date.getTime();
};

const assertDefaultRestoreContext = (context: SkeinContext): void => {
  if (
    !hasExactKeys(context, [
      "version",
      "revision",
      "conversation",
      "workflow",
      "runtime",
    ]) ||
    context.version !== "1.0" ||
    context.revision !== 0 ||
    !hasExactKeys(context.conversation, []) ||
    !hasExactKeys(context.workflow, ["state"]) ||
    !hasExactKeys(context.workflow.state, []) ||
    !hasExactKeys(context.runtime, [])
  ) {
    throw invalidRestoreCommand();
  }
};

/** Validates the provider-neutral zero-revision aggregate before persistence. */
export const validateRestoreSessionCommand = (
  command: RestoreSessionCommand,
): void => {
  const { session, providerBinding } = command;
  if (
    !validDurableString(session.id) ||
    !validDurableString(session.userId) ||
    session.status !== "ACTIVE" ||
    session.revision !== 0 ||
    providerBinding.sessionId !== session.id ||
    !validDurableString(providerBinding.provider) ||
    !validDurableString(providerBinding.providerKey) ||
    !validDurableString(providerBinding.externalConversationId, 8_192)
  ) {
    throw invalidRestoreCommand();
  }
  const createdAt = timestampOf(session.createdAt);
  const updatedAt = timestampOf(session.updatedAt);
  const lastActiveAt = timestampOf(session.lastActiveAt);
  if (createdAt > updatedAt || updatedAt > lastActiveAt) {
    throw invalidRestoreCommand();
  }
  assertDefaultRestoreContext(command.context);

  const ids = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const message of command.messages) {
    const messageTimestamp = timestampOf(message.createdAt);
    if (
      !validDurableString(message.id) ||
      message.sessionId !== session.id ||
      (message.role !== "USER" && message.role !== "ASSISTANT") ||
      typeof message.content !== "string" ||
      ids.has(message.id) ||
      messageTimestamp < previousTimestamp
    ) {
      throw invalidRestoreCommand();
    }
    ids.add(message.id);
    previousTimestamp = messageTimestamp;
  }
};

export interface CompactionCommitCommand {
  sessionId: string;
  expectedRevision: number;
  summary: ConversationSummary;
  compactedMessageIds: readonly string[];
  committedAt: string;
}

/**
 * Aggregate persistence boundary. Implementations must make commitTurn atomic
 * and enforce expectedRevision rather than silently overwriting state.
 */
export interface RuntimeStore {
  /**
   * Loads the active runtime aggregate. `messages` MUST exclude messages that
   * were already committed as compacted; public history remains available
   * through `getMessages`.
   */
  loadSessionAggregate(sessionId: string): Promise<SessionAggregate | null>;
  restoreSession(command: RestoreSessionCommand): Promise<RuntimeSession>;
  commitTurn(command: CommitTurnCommand): Promise<CommitTurnResult>;
  recordFailedTurn(command: FailedTurnCommand): Promise<void>;
  resetSession(command: ResetSessionCommand): Promise<void>;
  commitCompaction(command: CompactionCommitCommand): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSession | null>;
  /** Returns the complete canonical history, including compacted messages. */
  getMessages(sessionId: string): Promise<readonly CanonicalMessage[]>;
}
