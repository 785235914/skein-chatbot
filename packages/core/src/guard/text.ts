import { RuntimeError, RuntimeErrorCode } from "../errors/runtime-error.js";
import type { GuardInput } from "../ports/guard.js";

export const DEFAULT_MAX_GUARD_TEXT_LENGTH = 100_000;

export interface GuardTextOptions {
  maxTextLength?: number;
}

export const guardValidationError = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.VALIDATION_ERROR,
    "Guard input or configuration is invalid.",
  );

export const resolveMaxTextLength = (options: GuardTextOptions): number => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw guardValidationError();
  }
  const maxTextLength =
    options.maxTextLength ?? DEFAULT_MAX_GUARD_TEXT_LENGTH;
  if (!Number.isSafeInteger(maxTextLength) || maxTextLength <= 0) {
    throw guardValidationError();
  }
  return maxTextLength;
};

export const normalizeGuardText = (text: string): string =>
  text.replace(/\r\n?/gu, "\n").normalize("NFC");

export const normalizeGuardInput = (
  input: GuardInput,
  maxTextLength: number,
): GuardInput => {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.text !== "string" ||
    input.text.length > maxTextLength
  ) {
    throw guardValidationError();
  }

  const normalizedText = normalizeGuardText(input.text);
  if (normalizedText.length > maxTextLength) {
    throw guardValidationError();
  }

  return normalizedText === input.text
    ? input
    : { ...input, text: normalizedText };
};
