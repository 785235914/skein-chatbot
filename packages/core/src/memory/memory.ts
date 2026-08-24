import type { MessageRole } from "@skein-chatbot/contracts";

import type { ConversationSummary } from "./conversation-summary.js";

export type { ConversationSummary } from "./conversation-summary.js";
export * from "./conversation-summary.js";
export * from "./memory-context-builder.js";
export * from "./token-estimator.js";

export interface RuntimeMemoryMessage {
  readonly id?: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

/**
 * Semantic conversation context supplied to an orchestrator. A summary is
 * deliberately non-authoritative: workflow state lives only in SkeinContext.
 */
export interface RuntimeMemoryContext {
  readonly recentMessages: readonly RuntimeMemoryMessage[];
  readonly summary?: ConversationSummary;
}
