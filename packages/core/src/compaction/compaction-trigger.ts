import type { RuntimeConfig } from "../config/runtime-config.js";
import type { ConversationSummary } from "../memory/conversation-summary.js";
import type { RuntimeMemoryMessage } from "../memory/memory.js";
import { estimateConversationTokens } from "../memory/token-estimator.js";

export type CompactionConfiguration = Pick<
  RuntimeConfig,
  | "recentMessages"
  | "compactionMessageThreshold"
  | "compactionTokenThreshold"
>;

export type CompactionTriggerReason =
  | "MANUAL"
  | "MESSAGE_COUNT"
  | "ESTIMATED_TOKENS";

export interface CompactionTriggerInput {
  readonly messages: readonly RuntimeMemoryMessage[];
  readonly previousSummary?: ConversationSummary;
  readonly manual?: boolean;
}

export interface CompactionDecision {
  readonly shouldCompact: boolean;
  readonly reasons: readonly CompactionTriggerReason[];
  readonly messageCount: number;
  readonly estimatedTokens: number;
}

export const assertCompactionConfiguration = (
  config: CompactionConfiguration,
): void => {
  if (
    !Number.isSafeInteger(config.recentMessages) ||
    config.recentMessages < 0 ||
    !Number.isSafeInteger(config.compactionMessageThreshold) ||
    config.compactionMessageThreshold < 1 ||
    !Number.isFinite(config.compactionTokenThreshold) ||
    config.compactionTokenThreshold < 1
  ) {
    throw new RangeError("The compaction configuration is invalid.");
  }
};

export const evaluateCompactionTrigger = (
  config: CompactionConfiguration,
  input: CompactionTriggerInput,
): CompactionDecision => {
  assertCompactionConfiguration(config);
  const estimatedTokens = estimateConversationTokens(
    input.messages,
    input.previousSummary,
  );
  const reasons: CompactionTriggerReason[] = [];
  if (input.manual === true) {
    reasons.push("MANUAL");
  }
  if (input.messages.length >= config.compactionMessageThreshold) {
    reasons.push("MESSAGE_COUNT");
  }
  if (estimatedTokens >= config.compactionTokenThreshold) {
    reasons.push("ESTIMATED_TOKENS");
  }
  return Object.freeze({
    shouldCompact: reasons.length > 0,
    reasons: Object.freeze(reasons),
    messageCount: input.messages.length,
    estimatedTokens,
  });
};
