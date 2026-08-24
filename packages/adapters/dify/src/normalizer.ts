import {
  JsonObjectSchema,
  SourceSchema,
  type Source,
} from "@skein-chatbot/contracts";
import type {
  ContextPatch,
  OrchestrationInput,
  OrchestrationResult,
  OrchestrationStatus,
} from "@skein-chatbot/core";

import { createDifyInvalidResponseError } from "./errors.js";
import {
  getDifyPath,
  getFirstDifyPath,
  isDifyRecord,
} from "./path-access.js";
import type {
  DifyCanonicalInput,
  DifyFile,
  DifyProfile,
} from "./types.js";

const STATUSES: ReadonlySet<string> = new Set<OrchestrationStatus>([
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
]);

const canonicalInputValue = (
  key: DifyCanonicalInput,
  input: OrchestrationInput,
  profile: DifyProfile,
): unknown => {
  switch (key) {
    case "query":
      return input.query;
    case "context":
      return input.context;
    case "conversation":
      return input.context.conversation;
    case "workflowState":
      return input.context.workflow.state;
    case "memory":
      return input.memory;
    case "mode":
      return profile.modeMapping[input.mode];
    case "traceId":
      return input.traceId;
    case "turnId":
      return input.turnId;
    case "sessionId":
      return input.sessionId;
    case "metadata":
      return input.metadata ?? {};
    case "user":
      return input.user.userId;
  }
};

export const mapDifyInputs = (
  input: OrchestrationInput,
  profile: DifyProfile,
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {};
  for (const [canonical, variable] of Object.entries(profile.request)) {
    if (variable === undefined) {
      continue;
    }
    mapped[variable] = canonicalInputValue(
      canonical as DifyCanonicalInput,
      input,
      profile,
    );
  }
  return mapped;
};

const optionalString = (
  value: unknown,
  path: string | undefined,
): string | undefined => {
  if (path === undefined) {
    return undefined;
  }
  const selected = getDifyPath(value, path);
  if (selected === undefined || selected === null) {
    return undefined;
  }
  if (typeof selected !== "string") {
    throw createDifyInvalidResponseError();
  }
  return selected;
};

const sourceString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

const safeSourceUrl = (value: unknown): string | undefined => {
  const stringValue = sourceString(value);
  if (stringValue === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(stringValue);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

const normalizeSource = (
  value: unknown,
  profile: DifyProfile,
): Source | undefined => {
  if (!isDifyRecord(value)) {
    return undefined;
  }
  const title = sourceString(getFirstDifyPath(value, profile.source.title));
  if (title === undefined) {
    return undefined;
  }

  const candidate: Record<string, unknown> = { title };
  if (profile.source.id !== undefined) {
    const id = sourceString(getFirstDifyPath(value, profile.source.id));
    if (id !== undefined) {
      candidate.id = id;
    }
  }
  if (profile.source.url !== undefined) {
    const url = safeSourceUrl(getFirstDifyPath(value, profile.source.url));
    if (url !== undefined) {
      candidate.url = url;
    }
  }
  if (profile.source.provider !== undefined) {
    const provider = sourceString(
      getFirstDifyPath(value, profile.source.provider),
    );
    if (provider !== undefined) {
      candidate.provider = provider;
    }
  }
  if (profile.source.metadata !== undefined) {
    const metadata = JsonObjectSchema.safeParse(
      getFirstDifyPath(value, profile.source.metadata),
    );
    if (metadata.success) {
      candidate.metadata = metadata.data;
    }
  }

  const parsed = SourceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

export const normalizeDifySources = (
  raw: unknown,
  profile: DifyProfile,
): Source[] => {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw createDifyInvalidResponseError();
  }
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const source = normalizeSource(item, profile);
    if (source === undefined) {
      continue;
    }
    const identity = source.id ?? source.url ?? source.title;
    if (!seen.has(identity)) {
      seen.add(identity);
      sources.push(source);
    }
  }
  return sources;
};

const normalizeStatus = (
  value: unknown,
  profile: DifyProfile,
): OrchestrationStatus => {
  if (profile.response.status === undefined) {
    return "ANSWER";
  }
  const raw = getDifyPath(value, profile.response.status);
  if (raw === undefined || raw === null) {
    return "ANSWER";
  }
  if (typeof raw !== "string") {
    throw createDifyInvalidResponseError();
  }
  const mapped = Object.hasOwn(profile.statusMapping, raw)
    ? profile.statusMapping[raw]
    : undefined;
  if (mapped !== undefined) {
    return mapped;
  }
  if (STATUSES.has(raw)) {
    return raw as OrchestrationStatus;
  }
  throw createDifyInvalidResponseError();
};

const normalizeContextPatch = (
  value: unknown,
  profile: DifyProfile,
): ContextPatch | undefined => {
  const mapping = profile.response.contextPatch;
  if (mapping === undefined) {
    return undefined;
  }
  const patch: ContextPatch = {};
  if (mapping.conversation !== undefined) {
    const selected = getDifyPath(value, mapping.conversation);
    if (selected !== undefined && selected !== null) {
      const parsed = JsonObjectSchema.safeParse(selected);
      if (!parsed.success) {
        throw createDifyInvalidResponseError();
      }
      patch.conversation = parsed.data;
    }
  }
  if (mapping.workflowState !== undefined) {
    const selected = getDifyPath(value, mapping.workflowState);
    if (selected !== undefined && selected !== null) {
      const parsed = JsonObjectSchema.safeParse(selected);
      if (!parsed.success) {
        throw createDifyInvalidResponseError();
      }
      patch.workflowState = parsed.data;
    }
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
};

export interface NormalizeDifyResponseOptions {
  answer?: string;
  conversationId?: string;
  sources?: readonly Source[];
}

export const normalizeDifyResponse = (
  value: unknown,
  profile: DifyProfile,
  options: NormalizeDifyResponseOptions = {},
): OrchestrationResult => {
  if (!isDifyRecord(value)) {
    throw createDifyInvalidResponseError();
  }
  const selectedAnswer =
    options.answer ?? getDifyPath(value, profile.response.answer);
  if (typeof selectedAnswer !== "string") {
    throw createDifyInvalidResponseError();
  }
  const selectedConversationId =
    options.conversationId ??
    getDifyPath(value, profile.response.conversationId);
  if (
    typeof selectedConversationId !== "string" ||
    selectedConversationId.length === 0
  ) {
    throw createDifyInvalidResponseError();
  }

  const mappedSources = normalizeDifySources(
    profile.response.sources === undefined
      ? undefined
      : getDifyPath(value, profile.response.sources),
    profile,
  );
  const mergedSources = normalizeDifySources(
    [...(options.sources ?? []), ...mappedSources],
    {
      ...profile,
      source: {
        id: "id",
        title: "title",
        url: "url",
        provider: "provider",
        metadata: "metadata",
      },
    },
  );

  const result: OrchestrationResult = {
    answer: selectedAnswer,
    status: normalizeStatus(value, profile),
    sources: mergedSources,
    providerConversationId: selectedConversationId,
  };
  const followUpQuestion = optionalString(
    value,
    profile.response.followUpQuestion,
  );
  const followUpGuidance = optionalString(
    value,
    profile.response.followUpGuidance,
  );
  const contextPatch = normalizeContextPatch(value, profile);
  if (followUpQuestion !== undefined) {
    result.followUpQuestion = followUpQuestion;
  }
  if (followUpGuidance !== undefined) {
    result.followUpGuidance = followUpGuidance;
  }
  if (contextPatch !== undefined) {
    result.contextPatch = contextPatch;
  }
  return result;
};

const FILE_TYPES: ReadonlySet<string> = new Set([
  "document",
  "image",
  "audio",
  "video",
  "custom",
]);

export const validateDifyFiles = (
  files: readonly DifyFile[] | undefined,
): readonly DifyFile[] | undefined => {
  if (files === undefined) {
    return undefined;
  }
  if (files.length > 20) {
    throw createDifyInvalidResponseError();
  }
  for (const file of files) {
    if (!FILE_TYPES.has(file.type)) {
      throw createDifyInvalidResponseError();
    }
    if (file.transfer_method === "remote_url") {
      if (safeSourceUrl(file.url) === undefined) {
        throw createDifyInvalidResponseError();
      }
    } else if (file.upload_file_id.trim().length === 0) {
      throw createDifyInvalidResponseError();
    }
  }
  return files;
};
