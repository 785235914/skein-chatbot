import { RuntimeError, RuntimeErrorCode } from "../errors/runtime-error.js";
import type {
  GuardAction,
  GuardResult,
} from "../ports/guard.js";
import { extractCredentialValues } from "./credential-values.js";
import { normalizeGuardText } from "./text.js";

const actions: ReadonlySet<GuardAction> = new Set([
  "ALLOW",
  "REDACT",
  "REVIEW",
  "BLOCK",
]);

const invalidGuardResult = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    "A guard stage returned an invalid result.",
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const includesCredentialValue = (
  output: string,
  sensitiveValue: string,
): boolean => {
  if (sensitiveValue.length >= 4) {
    return output.includes(sensitiveValue);
  }

  const boundedValue = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(sensitiveValue)}(?=$|[^\\p{L}\\p{N}])`,
    "u",
  );
  return boundedValue.test(output);
};

export const validateGuardResult = (
  value: unknown,
  inputText: string,
  maxTextLength: number,
): GuardResult => {
  if (!isRecord(value)) {
    throw invalidGuardResult();
  }

  const sensitiveValues = extractCredentialValues(inputText);
  const includesSensitiveEcho = (output: string): boolean =>
    (inputText.length > 0 && output.includes(inputText)) ||
    sensitiveValues.some((sensitiveValue) =>
      includesCredentialValue(output, sensitiveValue),
    );

  const { action, safe, riskTypes, reason, sanitizedText } = value;
  if (
    typeof action !== "string" ||
    !actions.has(action as GuardAction) ||
    typeof safe !== "boolean" ||
    !Array.isArray(riskTypes) ||
    !riskTypes.every(
      (risk) =>
        typeof risk === "string" &&
        risk.length > 0 &&
        !includesSensitiveEcho(risk),
    ) ||
    (reason !== undefined &&
      (typeof reason !== "string" || includesSensitiveEcho(reason)))
  ) {
    throw invalidGuardResult();
  }

  const guardAction = action as GuardAction;
  const expectedSafe = guardAction === "ALLOW" || guardAction === "REDACT";
  if (safe !== expectedSafe) {
    throw invalidGuardResult();
  }

  let normalizedSanitizedText: string | undefined;
  if (guardAction === "REDACT") {
    if (typeof sanitizedText !== "string") {
      throw invalidGuardResult();
    }
    normalizedSanitizedText = normalizeGuardText(sanitizedText);
    if (
      normalizedSanitizedText.length > maxTextLength ||
      normalizedSanitizedText === inputText
    ) {
      throw invalidGuardResult();
    }
  } else if (
    (guardAction === "REVIEW" || guardAction === "BLOCK") &&
    sanitizedText !== undefined
  ) {
    throw invalidGuardResult();
  } else if (sanitizedText !== undefined && typeof sanitizedText !== "string") {
    throw invalidGuardResult();
  }

  const result: GuardResult = {
    action: guardAction,
    safe,
    riskTypes: [...riskTypes] as string[],
  };
  if (normalizedSanitizedText !== undefined) {
    result.sanitizedText = normalizedSanitizedText;
  } else if (typeof sanitizedText === "string") {
    result.sanitizedText = sanitizedText;
  }
  if (typeof reason === "string") {
    result.reason = reason;
  }
  return result;
};
