import {
  ConversationSummaryValidationError,
  normalizeConversationSummary,
  type ConversationSummary,
} from "../memory/conversation-summary.js";
import type { RuntimeMemoryMessage } from "../memory/memory.js";
import {
  RuntimeError,
  RuntimeErrorCode,
  throwIfAborted,
} from "../errors/runtime-error.js";
import type { Clock } from "../ports/clock.js";
import type { CompactionProvider } from "../ports/compaction.js";
import type {
  CanonicalMessage,
  RuntimeStore,
  SessionAggregate,
} from "../ports/runtime-store.js";
import {
  assertCompactionConfiguration,
  evaluateCompactionTrigger,
  type CompactionConfiguration,
  type CompactionDecision,
} from "./compaction-trigger.js";

export interface CompactionServiceDependencies {
  readonly store: RuntimeStore;
  readonly provider: CompactionProvider;
  readonly clock: Clock;
  readonly config: CompactionConfiguration;
}

export interface CompactionRequest {
  readonly sessionId: string;
  readonly manual?: boolean;
}

export interface CompactionCompletedResult {
  readonly status: "COMPACTED";
  readonly decision: CompactionDecision;
  readonly summary: ConversationSummary;
  readonly compactedMessageIds: readonly string[];
}

export interface CompactionSkippedResult {
  readonly status: "SKIPPED";
  readonly reason: "THRESHOLD_NOT_MET" | "NO_ELIGIBLE_MESSAGES";
  readonly decision: CompactionDecision;
}

export type CompactionResult =
  | CompactionCompletedResult
  | CompactionSkippedResult;

const normalizeStoredSummary = (
  summary: ConversationSummary | undefined,
): ConversationSummary | undefined => {
  if (summary === undefined) {
    return undefined;
  }
  try {
    return normalizeConversationSummary(summary);
  } catch (error) {
    if (error instanceof ConversationSummaryValidationError) {
      throw new RuntimeError(
        RuntimeErrorCode.CONTEXT_INVALID,
        "The stored conversation summary is invalid.",
        { cause: error },
      );
    }
    throw error;
  }
};

const normalizeProviderSummary = (value: unknown): ConversationSummary => {
  try {
    return normalizeConversationSummary(value);
  } catch (error) {
    if (error instanceof ConversationSummaryValidationError) {
      throw new RuntimeError(
        RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
        "The compaction provider returned an invalid summary.",
        { cause: error },
      );
    }
    throw error;
  }
};

const memoryMessage = (message: CanonicalMessage): RuntimeMemoryMessage =>
  Object.freeze({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  });

export const selectCompactionCandidates = (
  messages: readonly CanonicalMessage[],
  recentMessages: number,
): readonly CanonicalMessage[] => {
  if (!Number.isSafeInteger(recentMessages) || recentMessages < 0) {
    throw new RangeError("recentMessages must be a non-negative integer");
  }
  const compactableCount = Math.max(0, messages.length - recentMessages);
  return Object.freeze(messages.slice(0, compactableCount));
};

const skipped = (
  reason: CompactionSkippedResult["reason"],
  decision: CompactionDecision,
): CompactionSkippedResult => Object.freeze({ status: "SKIPPED", reason, decision });

/**
 * Compacts only semantic message history. It neither receives nor commits a
 * SkeinContext, so workflow state cannot be changed through this module.
 */
export class CompactionService {
  constructor(private readonly dependencies: CompactionServiceDependencies) {
    assertCompactionConfiguration(dependencies.config);
  }

  async compact(
    request: CompactionRequest,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "A session ID is required for compaction.",
      );
    }
    throwIfAborted(signal);
    const aggregate = await this.dependencies.store.loadSessionAggregate(
      request.sessionId,
    );
    throwIfAborted(signal);
    if (aggregate === null) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    if (aggregate.session.id !== request.sessionId) {
      throw new RuntimeError(
        RuntimeErrorCode.CONTEXT_INVALID,
        "The loaded session aggregate is inconsistent.",
      );
    }
    return this.compactAggregate(aggregate, request.manual === true, signal);
  }

  private async compactAggregate(
    aggregate: SessionAggregate,
    manual: boolean,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const previousSummary = normalizeStoredSummary(aggregate.summary);
    const decision = evaluateCompactionTrigger(this.dependencies.config, {
      messages: aggregate.messages,
      ...(previousSummary === undefined ? {} : { previousSummary }),
      ...(manual ? { manual: true } : {}),
    });
    if (!decision.shouldCompact) {
      return skipped("THRESHOLD_NOT_MET", decision);
    }

    const candidates = selectCompactionCandidates(
      aggregate.messages,
      this.dependencies.config.recentMessages,
    );
    if (candidates.length === 0) {
      return skipped("NO_ELIGIBLE_MESSAGES", decision);
    }

    const providerMessages = Object.freeze(candidates.map(memoryMessage));
    const input = Object.freeze({
      sessionId: aggregate.session.id,
      messages: providerMessages,
      ...(previousSummary === undefined ? {} : { previousSummary }),
    });
    throwIfAborted(signal);
    const rawSummary: unknown = await this.dependencies.provider.summarize(
      input,
      signal,
    );
    throwIfAborted(signal);
    const summary = normalizeProviderSummary(rawSummary);
    const compactedMessageIds = Object.freeze(
      candidates.map((message) => message.id),
    );
    await this.dependencies.store.commitCompaction({
      sessionId: aggregate.session.id,
      expectedRevision: aggregate.session.revision,
      summary,
      compactedMessageIds,
      committedAt: this.dependencies.clock.now().toISOString(),
    });
    return Object.freeze({
      status: "COMPACTED",
      decision,
      summary,
      compactedMessageIds,
    });
  }
}
