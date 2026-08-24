import type {
  ConversationSummary,
  RuntimeMemoryMessage,
} from "../memory/memory.js";

export interface CompactionInput {
  sessionId: string;
  messages: readonly RuntimeMemoryMessage[];
  previousSummary?: ConversationSummary;
}

export interface CompactionProvider {
  summarize(
    input: CompactionInput,
    signal?: AbortSignal,
  ): Promise<ConversationSummary>;
}
