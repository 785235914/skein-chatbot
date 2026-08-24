import type { ExecutionMode, MessageRole } from "@skein-chatbot/contracts";

import type { SkeinContext } from "../context/context.js";
import type { RuntimeErrorCode } from "../errors/runtime-error.js";
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
  commitTurn(command: CommitTurnCommand): Promise<CommitTurnResult>;
  recordFailedTurn(command: FailedTurnCommand): Promise<void>;
  resetSession(command: ResetSessionCommand): Promise<void>;
  commitCompaction(command: CompactionCommitCommand): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSession | null>;
  /** Returns the complete canonical history, including compacted messages. */
  getMessages(sessionId: string): Promise<readonly CanonicalMessage[]>;
}
