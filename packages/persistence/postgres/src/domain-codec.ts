import {
  DURABLE_PROVIDER_KEY_MAX_LENGTH,
  type CanonicalMessage,
  type ConversationSummary,
  type ProviderConversationBinding,
  type RuntimeSession,
  type SkeinContext,
} from "@skein-chatbot/core";

import {
  createContextInvalidError,
  createDatabaseError,
} from "./persistence-errors.js";

export type UnknownRecord = Record<string, unknown>;

const unsafeKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireRecord = (
  value: unknown,
  label: string,
): UnknownRecord => {
  if (!isRecord(value)) {
    throw createDatabaseError(new TypeError(`${label} is not an object.`));
  }
  return value;
};

const isJsonValue = (value: unknown, seen: WeakSet<object>): boolean => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return value.every((entry) => isJsonValue(entry, seen));
  }
  if (!isRecord(value) || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.entries(value).every(
    ([key, entry]) => !unsafeKeys.has(key) && isJsonValue(entry, seen),
  );
};

export const cloneJson = (value: unknown): unknown => {
  if (!isJsonValue(value, new WeakSet<object>())) {
    throw createContextInvalidError();
  }
  return structuredClone(value);
};

const optionalString = (
  record: UnknownRecord,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw createDatabaseError(new TypeError(`${key} is not a string.`));
  }
  return value;
};

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw createDatabaseError(new TypeError(`${label} is not an integer.`));
  }
  return value as number;
};

export const parseDatabaseDate = (value: unknown, label: string): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw createDatabaseError(new TypeError(`${label} is not a date.`));
  }
  return date.toISOString();
};

export const commandDate = (value: string, label: string): Date => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw createContextInvalidError(new TypeError(`${label} is not a date.`));
  }
  return date;
};

export const parseSkeinContext = (value: unknown): SkeinContext => {
  const context = requireRecord(value, "ContextState.value");
  const conversation = requireRecord(context["conversation"], "conversation");
  const workflow = requireRecord(context["workflow"], "workflow");
  const runtime = requireRecord(context["runtime"], "runtime");
  const state = workflow["state"];

  if (
    context["version"] !== "1.0" ||
    !isRecord(state) ||
    !isJsonValue(state, new WeakSet<object>())
  ) {
    throw createDatabaseError(new TypeError("Stored context is invalid."));
  }

  const revision = nonNegativeInteger(context["revision"], "revision");
  const topic = optionalString(conversation, "topic");
  const language = optionalString(conversation, "language");
  const lastTurnId = optionalString(runtime, "lastTurnId");
  const updatedAt = optionalString(runtime, "updatedAt");

  return {
    version: "1.0",
    revision,
    conversation: {
      ...(topic === undefined ? {} : { topic }),
      ...(language === undefined ? {} : { language }),
    },
    workflow: { state: structuredClone(state) },
    runtime: {
      ...(lastTurnId === undefined ? {} : { lastTurnId }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    },
  };
};

export const encodeSkeinContext = (value: SkeinContext): unknown => {
  try {
    const cloned = cloneJson(value);
    const parsed = parseSkeinContext(cloned);
    if (parsed.revision !== value.revision) {
      throw createContextInvalidError();
    }
    return cloned;
  } catch (error) {
    if (
      isRecord(error) &&
      error["code"] === "CONTEXT_INVALID"
    ) {
      throw error;
    }
    throw createContextInvalidError(error);
  }
};

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw createDatabaseError(new TypeError(`${label} is not a string array.`));
  }
  return [...value] as string[];
};

export const parseConversationSummary = (
  value: unknown,
): ConversationSummary => {
  const summary = requireRecord(value, "ConversationSummary.value");
  const entities = requireRecord(summary["entities"], "entities");
  if (
    typeof summary["summaryText"] !== "string" ||
    typeof summary["createdAt"] !== "string" ||
    Object.values(entities).some((entry) => typeof entry !== "string")
  ) {
    throw createDatabaseError(new TypeError("Stored summary is invalid."));
  }
  const topic = optionalString(summary, "topic");
  return {
    ...(topic === undefined ? {} : { topic }),
    userGoals: stringArray(summary["userGoals"], "userGoals"),
    confirmedFacts: stringArray(summary["confirmedFacts"], "confirmedFacts"),
    unresolvedIssues: stringArray(
      summary["unresolvedIssues"],
      "unresolvedIssues",
    ),
    entities: structuredClone(entities) as Record<string, string>,
    previousActions: stringArray(summary["previousActions"], "previousActions"),
    summaryText: summary["summaryText"],
    createdAt: summary["createdAt"],
  };
};

export const encodeConversationSummary = (
  value: ConversationSummary,
): unknown => {
  const cloned = cloneJson(value);
  try {
    parseConversationSummary(cloned);
  } catch (error) {
    throw createContextInvalidError(error);
  }
  return cloned;
};

const databaseString = (
  record: UnknownRecord,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw createDatabaseError(new TypeError(`${key} is not a string.`));
  }
  return value;
};

export const parseRuntimeSession = (
  rowValue: unknown,
  contextValue?: unknown,
): RuntimeSession => {
  const row = requireRecord(rowValue, "Session");
  const contextState = requireRecord(
    contextValue ?? row["contextState"],
    "ContextState",
  );
  const status = row["status"];
  if (status !== "ACTIVE" && status !== "RESET") {
    throw createDatabaseError(new TypeError("Stored session status is invalid."));
  }
  return {
    id: databaseString(row, "id"),
    userId: databaseString(row, "userId"),
    status,
    revision: nonNegativeInteger(contextState["revision"], "revision"),
    createdAt: parseDatabaseDate(row["createdAt"], "createdAt"),
    updatedAt: parseDatabaseDate(row["updatedAt"], "updatedAt"),
    lastActiveAt: parseDatabaseDate(row["lastActiveAt"], "lastActiveAt"),
  };
};

export const parseCanonicalMessage = (value: unknown): CanonicalMessage => {
  const row = requireRecord(value, "Message");
  const role = row["role"];
  if (role !== "USER" && role !== "ASSISTANT" && role !== "SYSTEM_EVENT") {
    throw createDatabaseError(new TypeError("Stored message role is invalid."));
  }
  return {
    id: databaseString(row, "id"),
    sessionId: databaseString(row, "sessionId"),
    role,
    content: databaseString(row, "content"),
    createdAt: parseDatabaseDate(row["createdAt"], "createdAt"),
  };
};

export const parseProviderBinding = (
  value: unknown,
): ProviderConversationBinding => {
  const row = requireRecord(value, "ProviderBinding");
  return {
    sessionId: databaseString(row, "sessionId"),
    provider: databaseString(row, "provider"),
    providerKey: databaseString(row, "providerKey"),
    externalConversationId: databaseString(row, "externalConversationId"),
  };
};

export const requireString = (
  value: unknown,
  label: string,
  maximumLength = DURABLE_PROVIDER_KEY_MAX_LENGTH,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw createContextInvalidError(new TypeError(`${label} is invalid.`));
  }
  return value;
};

export const requireNonNegativeInt = (
  value: unknown,
  label: string,
): number => {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 2_147_483_647
  ) {
    throw createContextInvalidError(new TypeError(`${label} is invalid.`));
  }
  return value as number;
};
