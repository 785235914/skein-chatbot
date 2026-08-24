import { describe, expect, it } from "vitest";

import { PublicErrorSchema } from "@skein-chatbot/contracts";
import { RuntimeError, RuntimeErrorCode } from "@skein-chatbot/core";

import { mapPublicError } from "../src/public-errors.js";

const HTTP_CASES = [
  [RuntimeErrorCode.VALIDATION_ERROR, 400],
  [RuntimeErrorCode.INPUT_BLOCKED, 400],
  [RuntimeErrorCode.PROVIDER_RATE_LIMITED, 429],
  [RuntimeErrorCode.SESSION_NOT_FOUND, 404],
  [RuntimeErrorCode.SESSION_CONFLICT, 409],
  [RuntimeErrorCode.ABORTED, 409],
  [RuntimeErrorCode.CONTEXT_INVALID, 422],
  [RuntimeErrorCode.PROVIDER_TIMEOUT, 504],
  [RuntimeErrorCode.PROVIDER_UNAVAILABLE, 503],
  [RuntimeErrorCode.DATABASE_ERROR, 503],
  [RuntimeErrorCode.PROVIDER_INVALID_RESPONSE, 502],
  [RuntimeErrorCode.ORCHESTRATION_FAILED, 502],
  [RuntimeErrorCode.OUTPUT_BLOCKED, 502],
  [RuntimeErrorCode.INTERNAL_ERROR, 500],
] as const;

describe("canonical public error mapping", () => {
  it.each(HTTP_CASES)("maps %s to HTTP %i", (code, statusCode) => {
    const response = mapPublicError(
      new RuntimeError(code, "PRIVATE provider failure and stack details", {
        retryable: true,
      }),
      "trace-test",
    );

    expect(response.statusCode).toBe(statusCode);
    const body = PublicErrorSchema.parse(response.body);
    expect(body.code).toBe(code);
    expect(body.traceId).toBe("trace-test");
    expect(body.message).not.toMatch(/PRIVATE|provider failure|stack/u);
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "message",
      "retryable",
      "traceId",
    ]);
  });

  it("maps unknown errors to a non-retryable canonical internal failure", () => {
    const response = mapPublicError(
      new Error("secret provider metadata"),
      "trace-internal",
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      retryable: false,
      traceId: "trace-internal",
    });
  });
});
