import type { ExecutionMode, Source } from "@skein-chatbot/contracts";

import type { ContextPatch, SkeinContext } from "../context/context.js";
import type { RuntimeMemoryContext } from "../memory/memory.js";
import type { RuntimeUserContext } from "../runtime/user-context.js";

export const DURABLE_PROVIDER_KEY_MAX_LENGTH = 191;

export type OrchestrationStatus =
  | "ANSWER"
  | "PARTIAL"
  | "NO_EVIDENCE"
  | "HANDOFF";

export interface OrchestrationInput {
  traceId: string;
  turnId: string;
  sessionId: string;
  query: string;
  mode: ExecutionMode;
  context: SkeinContext;
  memory: RuntimeMemoryContext;
  user: RuntimeUserContext;
  providerConversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationResult {
  answer: string;
  status: OrchestrationStatus;
  sources: Source[];
  followUpQuestion?: string;
  followUpGuidance?: string;
  contextPatch?: ContextPatch;
  providerConversationId?: string;
  providerMetadata?: Record<string, unknown>;
}

export type OrchestrationEvent =
  | { type: "status"; status: string }
  | { type: "delta"; text: string }
  | { type: "source"; source: Source }
  | { type: "completed"; result: OrchestrationResult };

export interface BusinessOrchestrator {
  execute(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult>;

  stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent>;
}
