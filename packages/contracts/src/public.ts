import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(JsonValueSchema);

export const ChatModeSchema = z.enum(["quick", "deep"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const ExecutionModeSchema = z.enum(["QUICK", "DEEP"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const ChatStatusSchema = z.enum([
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
  "ERROR",
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const SourceSchema = z
  .object({
    id: z.string().min(1).max(512).optional(),
    title: z.string().min(1).max(2048),
    url: z.string().url().max(4096).optional(),
    provider: z.string().min(1).max(128).optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type Source = z.infer<typeof SourceSchema>;

export const ChatRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(32_000),
    mode: ChatModeSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    answer: z.string(),
    status: ChatStatusSchema,
    sources: z.array(SourceSchema),
    followUpQuestion: z.string(),
    followUpGuidance: z.string(),
    metadata: JsonObjectSchema,
  })
  .strict();
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const RuntimeErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INPUT_BLOCKED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "ORCHESTRATION_FAILED",
  "OUTPUT_BLOCKED",
  "CONTEXT_INVALID",
  "SESSION_NOT_FOUND",
  "SESSION_CONFLICT",
  "ABORTED",
  "DATABASE_ERROR",
  "INTERNAL_ERROR",
]);
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

export const PublicErrorSchema = z
  .object({
    code: RuntimeErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    traceId: z.string().min(1),
  })
  .strict();
export type PublicError = z.infer<typeof PublicErrorSchema>;

export const MessageRoleSchema = z.enum([
  "USER",
  "ASSISTANT",
  "SYSTEM_EVENT",
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageViewSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    role: MessageRoleSchema,
    content: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MessageView = z.infer<typeof MessageViewSchema>;

export const SessionViewSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    status: z.enum(["ACTIVE", "RESET"]),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastActiveAt: z.string().datetime(),
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;

export const ResetSessionResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    status: z.literal("RESET"),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type ResetSessionResponse = z.infer<typeof ResetSessionResponseSchema>;

export const AbortSessionResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    aborted: z.boolean(),
  })
  .strict();
export type AbortSessionResponse = z.infer<typeof AbortSessionResponseSchema>;
