import {
  CONVERSATION_SUMMARY_LIMITS,
  normalizeConversationSummary,
  redactCredentialLikeMaterial,
  type ConversationSummary,
} from "../memory/conversation-summary.js";
import { throwIfAborted } from "../errors/runtime-error.js";
import type { Clock } from "../ports/clock.js";
import type {
  CompactionInput,
  CompactionProvider,
} from "../ports/compaction.js";

const MESSAGE_EXCERPT_CHARACTERS = 1_024;

const truncate = (value: string, maximumLength: number): string => {
  if (maximumLength <= 0) {
    return "";
  }
  if (value.length <= maximumLength) {
    return value;
  }
  let end = maximumLength - 1;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
};

const structuredCharacters = (
  summary: ConversationSummary | undefined,
): number => {
  if (summary === undefined) {
    return 0;
  }
  return (
    (summary.topic?.length ?? 0) +
    summary.userGoals.reduce((total, entry) => total + entry.length, 0) +
    summary.confirmedFacts.reduce((total, entry) => total + entry.length, 0) +
    summary.unresolvedIssues.reduce((total, entry) => total + entry.length, 0) +
    Object.entries(summary.entities).reduce(
      (total, [key, entry]) => total + key.length + entry.length,
      0,
    ) +
    summary.previousActions.reduce((total, entry) => total + entry.length, 0)
  );
};

const transcript = (input: CompactionInput): string => {
  const sections: string[] = [];
  if (input.previousSummary?.summaryText !== undefined) {
    sections.push(
      `[Previous semantic summary]\n${redactCredentialLikeMaterial(input.previousSummary.summaryText)}`,
    );
  }
  sections.push(
    `[Earlier messages]\n${input.messages
      .map(
        (message) =>
          `${message.role}: ${truncate(
            redactCredentialLikeMaterial(message.content),
            MESSAGE_EXCERPT_CHARACTERS,
          )}`,
      )
      .join("\n")}`,
  );
  return truncate(
    sections.join("\n\n"),
    CONVERSATION_SUMMARY_LIMITS.summaryTextCharacters,
  );
};

/**
 * A provider-free V1 fallback. It preserves a redacted semantic transcript and
 * never invents authoritative facts or workflow state from free-form text.
 */
export class DeterministicCompactionProvider implements CompactionProvider {
  constructor(private readonly clock: Clock) {}

  summarize(
    input: CompactionInput,
    signal?: AbortSignal,
  ): Promise<ConversationSummary> {
    throwIfAborted(signal);
    const previous =
      input.previousSummary === undefined
        ? undefined
        : normalizeConversationSummary(input.previousSummary);
    const summaryTextLimit = Math.min(
      CONVERSATION_SUMMARY_LIMITS.summaryTextCharacters,
      Math.max(
        0,
        CONVERSATION_SUMMARY_LIMITS.totalCharacters -
          structuredCharacters(previous),
      ),
    );
    const result = normalizeConversationSummary({
      ...(previous?.topic === undefined ? {} : { topic: previous.topic }),
      userGoals: previous?.userGoals ?? [],
      confirmedFacts: previous?.confirmedFacts ?? [],
      unresolvedIssues: previous?.unresolvedIssues ?? [],
      entities: previous?.entities ?? {},
      previousActions: previous?.previousActions ?? [],
      summaryText: truncate(
        transcript({
          ...input,
          ...(previous === undefined ? {} : { previousSummary: previous }),
        }),
        summaryTextLimit,
      ),
      createdAt: this.clock.now().toISOString(),
    });
    throwIfAborted(signal);
    return Promise.resolve(result);
  }
}
