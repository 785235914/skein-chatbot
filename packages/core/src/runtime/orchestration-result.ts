import { JsonObjectSchema, SourceSchema } from "@skein-chatbot/contracts";
import type { Source } from "@skein-chatbot/contracts";

import type { ContextPatch } from "../context/context.js";
import {
  createContextValidator,
  type ContextValidator,
} from "../context/context-validator.js";
import { RuntimeError, RuntimeErrorCode } from "../errors/runtime-error.js";
import type {
  OrchestrationResult,
  OrchestrationStatus,
} from "../orchestration/orchestration.js";

const statuses: ReadonlySet<string> = new Set<OrchestrationStatus>([
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResponse = (cause?: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    "The orchestrator returned an invalid response.",
    { cause },
  );

export const createInvalidResponseError = invalidResponse;

const defaultContextValidator = createContextValidator();

export const normalizeOrchestrationSource = (value: unknown): Source => {
  const parsed = SourceSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
};

export const normalizeContextPatch = (
  value: unknown,
  contextValidator: ContextValidator = defaultContextValidator,
): ContextPatch => contextValidator.validateProviderPatch(value);

const optionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
};

export const normalizeOrchestrationResult = (
  value: unknown,
  contextValidator: ContextValidator = defaultContextValidator,
): OrchestrationResult => {
  if (!isRecord(value) || typeof value.answer !== "string") {
    throw invalidResponse();
  }
  if (typeof value.status !== "string" || !statuses.has(value.status)) {
    throw invalidResponse();
  }
  if (!Array.isArray(value.sources)) {
    throw invalidResponse();
  }
  const sources = value.sources.map((source) => {
    return normalizeOrchestrationSource(source);
  });

  const result: OrchestrationResult = {
    answer: value.answer,
    status: value.status as OrchestrationStatus,
    sources,
  };
  const followUpQuestion = optionalString(value, "followUpQuestion");
  const followUpGuidance = optionalString(value, "followUpGuidance");
  const providerConversationId = optionalString(
    value,
    "providerConversationId",
  );
  if (
    providerConversationId !== undefined &&
    providerConversationId.length === 0
  ) {
    throw invalidResponse();
  }

  if (followUpQuestion !== undefined) {
    result.followUpQuestion = followUpQuestion;
  }
  if (followUpGuidance !== undefined) {
    result.followUpGuidance = followUpGuidance;
  }
  if (providerConversationId !== undefined) {
    result.providerConversationId = providerConversationId;
  }
  if (value.contextPatch !== undefined) {
    result.contextPatch = normalizeContextPatch(
      value.contextPatch,
      contextValidator,
    );
  }
  if (value.providerMetadata !== undefined) {
    const parsed = JsonObjectSchema.safeParse(value.providerMetadata);
    if (!parsed.success) {
      throw invalidResponse(parsed.error);
    }
    result.providerMetadata = parsed.data;
  }
  return result;
};
