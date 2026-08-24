import type { PublicError } from "@skein-chatbot/contracts";

export enum RuntimeErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INPUT_BLOCKED = "INPUT_BLOCKED",
  PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED",
  PROVIDER_INVALID_RESPONSE = "PROVIDER_INVALID_RESPONSE",
  ORCHESTRATION_FAILED = "ORCHESTRATION_FAILED",
  OUTPUT_BLOCKED = "OUTPUT_BLOCKED",
  CONTEXT_INVALID = "CONTEXT_INVALID",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_CONFLICT = "SESSION_CONFLICT",
  ABORTED = "ABORTED",
  DATABASE_ERROR = "DATABASE_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

export interface RuntimeErrorOptions {
  retryable?: boolean;
  cause?: unknown;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: RuntimeErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export const isRuntimeError = (error: unknown): error is RuntimeError =>
  error instanceof RuntimeError;

export const createAbortedError = (cause?: unknown): RuntimeError =>
  new RuntimeError(RuntimeErrorCode.ABORTED, "The operation was aborted.", {
    cause,
  });

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) {
    throw createAbortedError(signal.reason);
  }
};

const publicMessages: Readonly<Record<RuntimeErrorCode, string>> = {
  [RuntimeErrorCode.VALIDATION_ERROR]: "The request is invalid.",
  [RuntimeErrorCode.INPUT_BLOCKED]: "The request was blocked by a safety rule.",
  [RuntimeErrorCode.PROVIDER_TIMEOUT]:
    "The AI service took too long to respond.",
  [RuntimeErrorCode.PROVIDER_UNAVAILABLE]:
    "The AI service is temporarily unavailable.",
  [RuntimeErrorCode.PROVIDER_RATE_LIMITED]:
    "The AI service is temporarily rate limited.",
  [RuntimeErrorCode.PROVIDER_INVALID_RESPONSE]:
    "The AI service returned an invalid response.",
  [RuntimeErrorCode.ORCHESTRATION_FAILED]:
    "The request could not be completed.",
  [RuntimeErrorCode.OUTPUT_BLOCKED]:
    "The response was blocked by a safety rule.",
  [RuntimeErrorCode.CONTEXT_INVALID]: "The conversation context is invalid.",
  [RuntimeErrorCode.SESSION_NOT_FOUND]: "The session was not found.",
  [RuntimeErrorCode.SESSION_CONFLICT]:
    "The session changed while the request was running.",
  [RuntimeErrorCode.ABORTED]: "The request was aborted.",
  [RuntimeErrorCode.DATABASE_ERROR]: "The session store is unavailable.",
  [RuntimeErrorCode.INTERNAL_ERROR]: "An internal error occurred.",
};

export const toRuntimeError = (
  error: unknown,
  signal?: AbortSignal,
): RuntimeError => {
  if (signal?.aborted === true) {
    return createAbortedError(error);
  }
  if (isRuntimeError(error)) {
    return error;
  }
  return new RuntimeError(
    RuntimeErrorCode.ORCHESTRATION_FAILED,
    publicMessages[RuntimeErrorCode.ORCHESTRATION_FAILED],
    { cause: error },
  );
};

export const toPublicError = (
  error: RuntimeError,
  traceId: string,
): PublicError => ({
  code: error.code,
  message: publicMessages[error.code],
  retryable: error.retryable,
  traceId,
});
