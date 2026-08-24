import type { CanonicalMessage } from "../ports/runtime-store.js";
import {
  normalizeConversationSummary,
  type ConversationSummary,
} from "./conversation-summary.js";
import type {
  RuntimeMemoryContext,
  RuntimeMemoryMessage,
} from "./memory.js";
import { estimateConversationTokens } from "./token-estimator.js";

export interface MemoryContextBuilderOptions {
  readonly recentMessages: number;
}

export interface MemoryContextBuilderInput {
  /** Messages must already be in canonical chronological storage order. */
  readonly messages: readonly CanonicalMessage[];
  readonly summary?: ConversationSummary;
}

const assertRecentMessageCount = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("recentMessages must be a non-negative integer");
  }
};

const immutableMemoryMessage = (
  message: CanonicalMessage,
): RuntimeMemoryMessage =>
  Object.freeze({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  });

/** Builds semantic memory only; structured workflow context is out of scope. */
export class MemoryContextBuilder {
  private readonly recentMessages: number;

  constructor(options: MemoryContextBuilderOptions) {
    assertRecentMessageCount(options.recentMessages);
    this.recentMessages = options.recentMessages;
  }

  build(input: MemoryContextBuilderInput): RuntimeMemoryContext {
    const start = Math.max(0, input.messages.length - this.recentMessages);
    const recentMessages = Object.freeze(
      (this.recentMessages === 0 ? [] : input.messages.slice(start)).map(
        immutableMemoryMessage,
      ),
    );
    const summary =
      input.summary === undefined
        ? undefined
        : normalizeConversationSummary(input.summary);
    return Object.freeze({
      recentMessages,
      ...(summary === undefined ? {} : { summary }),
    });
  }

  estimateTokens(input: MemoryContextBuilderInput): number {
    const memory = this.build(input);
    return estimateConversationTokens(memory.recentMessages, memory.summary);
  }
}
