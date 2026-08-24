import {
  RuntimeError,
  RuntimeErrorCode,
  createAbortedError,
  isRuntimeError,
} from "@skein-chatbot/core";

const timeoutError = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_TIMEOUT,
    "The provider request timed out.",
    { retryable: true },
  );

const isTimeoutReason = (reason: unknown): boolean =>
  (reason instanceof DOMException && reason.name === "TimeoutError") ||
  (typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError");

export const createDifyInvalidResponseError = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    "The provider returned an invalid response.",
  );

export const mapDifyHttpError = (
  status: number,
  providerCode = "",
): RuntimeError => {
  if (status === 408) {
    return timeoutError();
  }
  if (status === 429) {
    return new RuntimeError(
      RuntimeErrorCode.PROVIDER_RATE_LIMITED,
      "The provider rate limit was reached.",
      { retryable: providerCode.toLowerCase() !== "rate_limit_error" },
    );
  }
  if (status >= 500) {
    return new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      "The provider is unavailable.",
      { retryable: true },
    );
  }
  if (status === 401 || status === 403) {
    return new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      "The provider configuration is unavailable.",
    );
  }
  if (
    status === 400 &&
    /(?:app_unavailable|provider_not|provider_quota|configuration|not_initialized|model_currently_not_support)/iu.test(
      providerCode,
    )
  ) {
    return new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      "The provider configuration is unavailable.",
    );
  }
  return new RuntimeError(
    RuntimeErrorCode.ORCHESTRATION_FAILED,
    "The provider rejected the request.",
  );
};

export const mapDifyStreamError = (payload: Record<string, unknown>): RuntimeError => {
  const code = typeof payload.code === "string" ? payload.code.toLowerCase() : "";
  const status = payload.status;
  if (typeof status === "number" && Number.isInteger(status)) {
    return mapDifyHttpError(status, code);
  }
  if (code.includes("rate_limit") || code.includes("too_many_requests")) {
    return mapDifyHttpError(429, code);
  }
  if (code.includes("timeout")) {
    return timeoutError();
  }
  if (
    code.includes("internal") ||
    code.includes("service_unavailable") ||
    code.includes("bad_gateway")
  ) {
    return mapDifyHttpError(500);
  }
  return new RuntimeError(
    RuntimeErrorCode.ORCHESTRATION_FAILED,
    "The provider stream reported a failure.",
  );
};

export const mapDifyTransportError = (
  error: unknown,
  signal?: AbortSignal,
): RuntimeError => {
  if (isRuntimeError(error)) {
    return error;
  }
  if (signal?.aborted === true) {
    return isTimeoutReason(signal.reason)
      ? timeoutError()
      : createAbortedError();
  }
  return new RuntimeError(
    RuntimeErrorCode.PROVIDER_UNAVAILABLE,
    "The provider could not be reached.",
    { retryable: true },
  );
};
