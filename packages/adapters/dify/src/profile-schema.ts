import { z } from "zod";

import { DIFY_STREAM_STATUS_ALLOWLIST } from "./types.js";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PATH_SEGMENTS = 12;

const pathSegments = (path: string): readonly string[] => path.split(".");

export const isSafeDifyPath = (path: string): boolean => {
  const segments = pathSegments(path);
  return (
    path.length <= 512 &&
    segments.length <= MAX_PATH_SEGMENTS &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 128 &&
        /^[A-Za-z0-9_-]+$/u.test(segment) &&
        !FORBIDDEN_SEGMENTS.has(segment),
    )
  );
};

const DifyPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeDifyPath, "Path must be a bounded dot-separated property path.");

const DifyPathSelectionSchema = z.union([
  DifyPathSchema,
  z.array(DifyPathSchema).min(1).max(8),
]);

const DifyVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u)
  .refine((value) => !FORBIDDEN_SEGMENTS.has(value), {
    message: "Variable name is reserved.",
  });

const EventNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u)
  .refine((value) => !FORBIDDEN_SEGMENTS.has(value), {
    message: "Event name is reserved.",
  });

const RequestMappingSchema = z
  .object({
    query: DifyVariableNameSchema.optional(),
    context: DifyVariableNameSchema.optional(),
    conversation: DifyVariableNameSchema.optional(),
    workflowState: DifyVariableNameSchema.optional(),
    memory: DifyVariableNameSchema.optional(),
    mode: DifyVariableNameSchema.optional(),
    traceId: DifyVariableNameSchema.optional(),
    turnId: DifyVariableNameSchema.optional(),
    sessionId: DifyVariableNameSchema.optional(),
    metadata: DifyVariableNameSchema.optional(),
    user: DifyVariableNameSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const names = Object.values(value).filter(
      (candidate): candidate is string => candidate !== undefined,
    );
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Request variable names must be unique.",
      });
    }
  })
  .default({});

const ContextPatchMappingSchema = z
  .object({
    conversation: DifyPathSchema.optional(),
    workflowState: DifyPathSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.conversation !== undefined || value.workflowState !== undefined,
    "At least one context patch path is required.",
  );

const ResponseMappingSchema = z
  .object({
    answer: DifyPathSchema.default("answer"),
    status: DifyPathSchema.optional(),
    sources: DifyPathSchema.optional().default("metadata.retriever_resources"),
    followUpQuestion: DifyPathSchema.optional(),
    followUpGuidance: DifyPathSchema.optional(),
    conversationId: DifyPathSchema.default("conversation_id"),
    contextPatch: ContextPatchMappingSchema.optional(),
  })
  .strict()
  .default({});

const SourceMappingSchema = z
  .object({
    id: DifyPathSelectionSchema.optional().default([
      "segment_id",
      "document_id",
      "id",
    ]),
    title: DifyPathSelectionSchema.default([
      "document_name",
      "dataset_name",
      "title",
    ]),
    url: DifyPathSelectionSchema.optional().default("url"),
    provider: DifyPathSelectionSchema.optional(),
    metadata: DifyPathSelectionSchema.optional().default("doc_metadata"),
  })
  .strict()
  .default({});

const OrchestrationStatusSchema = z.enum([
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
]);

const StreamStatusSchema = z.enum(DIFY_STREAM_STATUS_ALLOWLIST);

const boundedStatusMapping = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z
    .record(EventNameSchema, valueSchema)
    .default({})
    .refine((value) => Object.keys(value).length <= 32, {
      message: "A mapping may contain at most 32 entries.",
    });

const StreamMappingSchema = z
  .object({
    event: DifyPathSchema.default("event"),
    text: DifyPathSchema.default("answer"),
    conversationId: DifyPathSchema.default("conversation_id"),
    textEvents: z
      .array(EventNameSchema)
      .min(1)
      .max(16)
      .default(["message", "agent_message"]),
    terminalEvents: z
      .array(EventNameSchema)
      .min(1)
      .max(8)
      .default(["message_end"]),
    errorEvents: z.array(EventNameSchema).min(1).max(8).default(["error"]),
    statusMapping: boundedStatusMapping(StreamStatusSchema),
  })
  .strict()
  .default({});

export const DifyProfileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
    request: RequestMappingSchema,
    modeMapping: z
      .object({
        QUICK: z.string().min(1).max(128),
        DEEP: z.string().min(1).max(128),
      })
      .strict()
      .default({ QUICK: "QUICK", DEEP: "DEEP" }),
    response: ResponseMappingSchema,
    statusMapping: boundedStatusMapping(OrchestrationStatusSchema),
    source: SourceMappingSchema,
    stream: StreamMappingSchema,
    transport: z
      .object({
        executeResponseMode: z
          .enum(["blocking", "streaming"])
          .default("blocking"),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ParsedDifyProfile = z.infer<typeof DifyProfileSchema>;
