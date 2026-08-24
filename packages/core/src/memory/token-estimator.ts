import type { ConversationSummary } from "./conversation-summary.js";
import type { RuntimeMemoryMessage } from "./memory.js";

const encoder = new TextEncoder();

/** A deterministic, provider-neutral approximation: four UTF-8 bytes/token. */
export const estimateTextTokens = (value: string): number =>
  value.length === 0 ? 0 : Math.ceil(encoder.encode(value).byteLength / 4);

export const estimateMessagesTokens = (
  messages: readonly RuntimeMemoryMessage[],
): number =>
  messages.reduce(
    (total, message) =>
      total + 4 + estimateTextTokens(message.role) + estimateTextTokens(message.content),
    0,
  );

export const estimateSummaryTokens = (
  summary: ConversationSummary | undefined,
): number => {
  if (summary === undefined) {
    return 0;
  }
  const values = [
    summary.topic ?? "",
    ...summary.userGoals,
    ...summary.confirmedFacts,
    ...summary.unresolvedIssues,
    ...Object.keys(summary.entities),
    ...Object.values(summary.entities),
    ...summary.previousActions,
    summary.summaryText,
  ];
  return 8 + values.reduce((total, value) => total + estimateTextTokens(value), 0);
};

export const estimateConversationTokens = (
  messages: readonly RuntimeMemoryMessage[],
  summary?: ConversationSummary,
): number => estimateMessagesTokens(messages) + estimateSummaryTokens(summary);
