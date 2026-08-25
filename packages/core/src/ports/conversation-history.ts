export interface ConversationHistoryEntry {
  id: string;
  userContent: string;
  assistantContent: string;
  createdAt: string;
}

export interface ConversationHistorySource {
  loadHistory(
    input: {
      externalConversationId: string;
      userId: string;
      maximumEntries: number;
    },
    signal?: AbortSignal,
  ): Promise<readonly ConversationHistoryEntry[]>;
}
