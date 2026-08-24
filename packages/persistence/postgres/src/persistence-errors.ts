import {
  RuntimeError,
  RuntimeErrorCode,
  isRuntimeError,
} from "@skein-chatbot/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const prismaCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error["code"];
  return typeof code === "string" ? code : undefined;
};

const retryableDatabaseCodes: ReadonlySet<string> = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
]);

const optimisticConflictCodes: ReadonlySet<string> = new Set([
  "P2002",
  "P2025",
  "P2034",
]);

export const createSessionConflictError = (cause?: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.SESSION_CONFLICT,
    "The session revision did not match.",
    { retryable: true, ...(cause === undefined ? {} : { cause }) },
  );

export const createContextInvalidError = (cause?: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.CONTEXT_INVALID,
    "The persistence command contains invalid state.",
    cause === undefined ? {} : { cause },
  );

export const createDatabaseError = (error: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.DATABASE_ERROR,
    "The session store operation failed.",
    {
      retryable: retryableDatabaseCodes.has(prismaCode(error) ?? ""),
      cause: error,
    },
  );

export const mapPrismaError = (
  error: unknown,
  options: { optimisticConflict?: boolean } = {},
): RuntimeError => {
  if (isRuntimeError(error)) {
    return error;
  }
  if (
    options.optimisticConflict === true &&
    optimisticConflictCodes.has(prismaCode(error) ?? "")
  ) {
    return createSessionConflictError(error);
  }
  return createDatabaseError(error);
};
