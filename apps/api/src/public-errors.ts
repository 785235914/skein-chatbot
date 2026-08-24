import type { FastifyReply } from "fastify";

import type { PublicError } from "@skein-chatbot/contracts";
import {
  isRuntimeError,
  RuntimeError,
  RuntimeErrorCode,
  toPublicError,
} from "@skein-chatbot/core";

interface ErrorDefinition {
  retryable: boolean;
  statusCode: number;
}

const ERROR_DEFINITIONS: Readonly<Record<RuntimeErrorCode, ErrorDefinition>> = {
  [RuntimeErrorCode.VALIDATION_ERROR]: {
    retryable: false,
    statusCode: 400,
  },
  [RuntimeErrorCode.INPUT_BLOCKED]: {
    retryable: false,
    statusCode: 400,
  },
  [RuntimeErrorCode.PROVIDER_TIMEOUT]: {
    retryable: true,
    statusCode: 504,
  },
  [RuntimeErrorCode.PROVIDER_UNAVAILABLE]: {
    retryable: true,
    statusCode: 503,
  },
  [RuntimeErrorCode.PROVIDER_RATE_LIMITED]: {
    retryable: true,
    statusCode: 429,
  },
  [RuntimeErrorCode.PROVIDER_INVALID_RESPONSE]: {
    retryable: false,
    statusCode: 502,
  },
  [RuntimeErrorCode.ORCHESTRATION_FAILED]: {
    retryable: false,
    statusCode: 502,
  },
  [RuntimeErrorCode.OUTPUT_BLOCKED]: {
    retryable: false,
    statusCode: 502,
  },
  [RuntimeErrorCode.CONTEXT_INVALID]: {
    retryable: false,
    statusCode: 422,
  },
  [RuntimeErrorCode.SESSION_NOT_FOUND]: {
    retryable: false,
    statusCode: 404,
  },
  [RuntimeErrorCode.SESSION_CONFLICT]: {
    retryable: true,
    statusCode: 409,
  },
  [RuntimeErrorCode.ABORTED]: {
    retryable: false,
    statusCode: 409,
  },
  [RuntimeErrorCode.DATABASE_ERROR]: {
    retryable: true,
    statusCode: 503,
  },
  [RuntimeErrorCode.INTERNAL_ERROR]: {
    retryable: false,
    statusCode: 500,
  },
};

export interface PublicErrorResponse {
  body: PublicError;
  statusCode: number;
}

const definitionForRuntimeError = (error: RuntimeError): ErrorDefinition => {
  const definition = ERROR_DEFINITIONS[error.code];
  return {
    ...definition,
    retryable: definition.retryable && error.retryable,
  };
};

export const createPublicError = (
  code: RuntimeErrorCode,
  traceId: string,
): PublicErrorResponse => {
  const definition = ERROR_DEFINITIONS[code];
  const syntheticError = new RuntimeError(code, definition.statusCode.toString(), {
    retryable: definition.retryable,
  });
  return {
    body: toPublicError(syntheticError, traceId),
    statusCode: definition.statusCode,
  };
};

export const mapPublicError = (
  error: unknown,
  traceId: string,
): PublicErrorResponse => {
  if (!isRuntimeError(error)) {
    return createPublicError(RuntimeErrorCode.INTERNAL_ERROR, traceId);
  }

  const definition = definitionForRuntimeError(error);
  return {
    body: {
      ...toPublicError(error, traceId),
      retryable: definition.retryable,
    },
    statusCode: definition.statusCode,
  };
};

export const sendPublicError = (
  reply: FastifyReply,
  response: PublicErrorResponse,
): FastifyReply => reply.code(response.statusCode).send(response.body);
