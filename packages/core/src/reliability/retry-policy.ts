import {
  RuntimeErrorCode,
  isRuntimeError,
} from "../errors/runtime-error.js";

const transientProviderCodes: ReadonlySet<RuntimeErrorCode> = new Set([
  RuntimeErrorCode.PROVIDER_TIMEOUT,
  RuntimeErrorCode.PROVIDER_UNAVAILABLE,
  RuntimeErrorCode.PROVIDER_RATE_LIMITED,
]);

/** Only adapter-normalized, explicitly retryable transient errors may retry. */
export const isRetryableProviderFailure = (error: unknown): boolean =>
  isRuntimeError(error) &&
  error.retryable &&
  transientProviderCodes.has(error.code);
