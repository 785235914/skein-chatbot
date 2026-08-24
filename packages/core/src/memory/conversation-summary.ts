export interface ConversationSummary {
  readonly topic?: string;
  readonly userGoals: readonly string[];
  readonly confirmedFacts: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly entities: Readonly<Record<string, string>>;
  readonly previousActions: readonly string[];
  readonly summaryText: string;
  readonly createdAt: string;
}

export const CONVERSATION_SUMMARY_LIMITS = Object.freeze({
  topicCharacters: 256,
  listItems: 32,
  listItemCharacters: 1_024,
  entities: 64,
  entityKeyCharacters: 128,
  entityValueCharacters: 1_024,
  summaryTextCharacters: 8_192,
  totalCharacters: 32_768,
});

export const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]";

const forbiddenEntityKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const allowedSummaryKeys: ReadonlySet<string> = new Set([
  "topic",
  "userGoals",
  "confirmedFacts",
  "unresolvedIssues",
  "entities",
  "previousActions",
  "summaryText",
  "createdAt",
]);

export class ConversationSummaryValidationError extends TypeError {
  constructor() {
    super("The conversation summary is invalid.");
    this.name = "ConversationSummaryValidationError";
  }
}

const invalidSummary = (): never => {
  throw new ConversationSummaryValidationError();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Conservatively removes material that resembles a credential. Compaction is
 * lossy by design, so preserving an opaque token is never worth the leak risk.
 */
export const redactCredentialLikeMaterial = (value: string): string =>
  value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
      REDACTED_CREDENTIAL,
    )
    .replace(
      /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu,
      `$1${REDACTED_CREDENTIAL}@`,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
      `$1 ${REDACTED_CREDENTIAL}`,
    )
    .replace(
      /((?:["']?\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|client[-_ ]?secret|password|passwd|pwd|secret)["']?)\s*[:=]\s*)(?:["'][^"'\r\n]*["']|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/giu,
      `$1${REDACTED_CREDENTIAL}`,
    )
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|(?:sk|app)-[A-Za-z0-9_-]{16,})\b/gu,
      REDACTED_CREDENTIAL,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED_CREDENTIAL,
    )
    .replace(
      /\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}\b/gu,
      REDACTED_CREDENTIAL,
    );

const boundedSanitizedString = (
  value: unknown,
  maximumLength: number,
): string => {
  if (typeof value !== "string") {
    return invalidSummary();
  }
  if (value.length > maximumLength) {
    return invalidSummary();
  }
  const sanitized = redactCredentialLikeMaterial(value);
  if (sanitized.length > maximumLength) {
    return invalidSummary();
  }
  return sanitized;
};

const boundedStringArray = (value: unknown): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > CONVERSATION_SUMMARY_LIMITS.listItems
  ) {
    return invalidSummary();
  }
  return Object.freeze(
    value.map((entry) =>
      boundedSanitizedString(
        entry,
        CONVERSATION_SUMMARY_LIMITS.listItemCharacters,
      ),
    ),
  );
};

const sanitizedEntities = (
  value: unknown,
): Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    return invalidSummary();
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    return invalidSummary();
  }
  const entries = Object.entries(value);
  if (entries.length > CONVERSATION_SUMMARY_LIMITS.entities) {
    return invalidSummary();
  }

  const sanitized: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [rawKey, rawValue] of entries) {
    if (
      rawKey.length === 0 ||
      rawKey.length > CONVERSATION_SUMMARY_LIMITS.entityKeyCharacters ||
      forbiddenEntityKeys.has(rawKey)
    ) {
      return invalidSummary();
    }
    const key = redactCredentialLikeMaterial(rawKey);
    if (Object.hasOwn(sanitized, key)) {
      return invalidSummary();
    }
    sanitized[key] = boundedSanitizedString(
      rawValue,
      CONVERSATION_SUMMARY_LIMITS.entityValueCharacters,
    );
  }
  return Object.freeze(sanitized);
};

const canonicalTimestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64) {
    return invalidSummary();
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    return invalidSummary();
  }
  return timestamp.toISOString();
};

/**
 * Strictly validates an untrusted provider value, redacts credential-like
 * strings, canonicalizes its timestamp, and returns a deeply frozen copy.
 */
export const normalizeConversationSummary = (
  value: unknown,
): ConversationSummary => {
  if (!isRecord(value)) {
    return invalidSummary();
  }
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowedSummaryKeys.has(key),
    )
  ) {
    return invalidSummary();
  }

  const topic =
    value["topic"] === undefined
      ? undefined
      : boundedSanitizedString(
          value["topic"],
          CONVERSATION_SUMMARY_LIMITS.topicCharacters,
        );
  const summary: ConversationSummary = {
    ...(topic === undefined ? {} : { topic }),
    userGoals: boundedStringArray(value["userGoals"]),
    confirmedFacts: boundedStringArray(value["confirmedFacts"]),
    unresolvedIssues: boundedStringArray(value["unresolvedIssues"]),
    entities: sanitizedEntities(value["entities"]),
    previousActions: boundedStringArray(value["previousActions"]),
    summaryText: boundedSanitizedString(
      value["summaryText"],
      CONVERSATION_SUMMARY_LIMITS.summaryTextCharacters,
    ),
    createdAt: canonicalTimestamp(value["createdAt"]),
  };
  const totalCharacters =
    (summary.topic?.length ?? 0) +
    summary.userGoals.reduce((total, entry) => total + entry.length, 0) +
    summary.confirmedFacts.reduce((total, entry) => total + entry.length, 0) +
    summary.unresolvedIssues.reduce((total, entry) => total + entry.length, 0) +
    Object.entries(summary.entities).reduce(
      (total, [key, entry]) => total + key.length + entry.length,
      0,
    ) +
    summary.previousActions.reduce((total, entry) => total + entry.length, 0) +
    summary.summaryText.length;
  if (totalCharacters > CONVERSATION_SUMMARY_LIMITS.totalCharacters) {
    return invalidSummary();
  }
  return Object.freeze(summary);
};
