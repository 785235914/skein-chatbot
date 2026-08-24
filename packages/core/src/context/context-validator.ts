import { RuntimeError, RuntimeErrorCode } from "../errors/runtime-error.js";

import {
  DEFAULT_CONTEXT_VALIDATION_LIMITS,
  type ContextPatch,
  type ContextValidationLimits,
  type ContextValidationOptions,
  type SkeinContext,
} from "./context.js";
import {
  RUNTIME_OWNED_CONTEXT_KEYS,
  cloneBoundedJsonObject,
} from "./json-safety.js";

export interface ContextValidator {
  readonly limits: Readonly<ContextValidationLimits>;
  validateContext(value: unknown): SkeinContext;
  validateProviderPatch(value: unknown): ContextPatch;
}

const contextInvalid = (cause: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.CONTEXT_INVALID,
    "The conversation context is invalid.",
    { cause },
  );

const providerPatchInvalid = (cause: unknown): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    "The orchestrator returned an invalid context patch.",
    { cause },
  );

const validationFailure = (message: string): TypeError =>
  new TypeError(message);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = new Set<string>(),
): void => {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw validationFailure("Context contains an unknown field.");
  }
  if (Array.from(required).some((key) => !hasOwn(value, key))) {
    throw validationFailure("Context is missing a required field.");
  }
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationFailure("Context field must be an object.");
  }
  return value as Record<string, unknown>;
};

const resolveLimits = (
  supplied: ContextValidationLimits | undefined,
): Readonly<ContextValidationLimits> => {
  const limits = supplied ?? DEFAULT_CONTEXT_VALIDATION_LIMITS;
  if (
    !Number.isSafeInteger(limits.maxSerializedBytes) ||
    limits.maxSerializedBytes < 2 ||
    !Number.isSafeInteger(limits.maxObjectDepth) ||
    limits.maxObjectDepth < 0 ||
    !Number.isSafeInteger(limits.maxArrayLength) ||
    limits.maxArrayLength < 0
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The context validation limits are invalid.",
    );
  }
  return Object.freeze({ ...limits });
};

const parseConversation = (
  value: unknown,
): SkeinContext["conversation"] => {
  const record = asObject(value);
  assertExactKeys(record, new Set(["topic", "language"]));

  const conversation: SkeinContext["conversation"] = {};
  if (hasOwn(record, "topic")) {
    if (typeof record.topic !== "string") {
      throw validationFailure("Context conversation topic must be a string.");
    }
    conversation.topic = record.topic;
  }
  if (hasOwn(record, "language")) {
    if (typeof record.language !== "string") {
      throw validationFailure(
        "Context conversation language must be a string.",
      );
    }
    conversation.language = record.language;
  }
  return conversation;
};

const parseRuntime = (value: unknown): SkeinContext["runtime"] => {
  const record = asObject(value);
  assertExactKeys(record, new Set(["lastTurnId", "updatedAt"]));

  const runtime: SkeinContext["runtime"] = {};
  if (hasOwn(record, "lastTurnId")) {
    if (typeof record.lastTurnId !== "string") {
      throw validationFailure("Context lastTurnId must be a string.");
    }
    runtime.lastTurnId = record.lastTurnId;
  }
  if (hasOwn(record, "updatedAt")) {
    if (typeof record.updatedAt !== "string") {
      throw validationFailure("Context updatedAt must be a string.");
    }
    runtime.updatedAt = record.updatedAt;
  }
  return runtime;
};

const parseContext = (
  value: unknown,
  options: ContextValidationOptions,
  limits: Readonly<ContextValidationLimits>,
): SkeinContext => {
  const record = cloneBoundedJsonObject(value, limits);
  assertExactKeys(
    record,
    new Set(["version", "revision", "conversation", "workflow", "runtime"]),
    new Set(["version", "revision", "conversation", "workflow", "runtime"]),
  );
  if (record.version !== "1.0") {
    throw validationFailure("Context version is not supported.");
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw validationFailure("Context revision must be a non-negative integer.");
  }

  const workflow = asObject(record.workflow);
  assertExactKeys(workflow, new Set(["state"]), new Set(["state"]));
  const safeState = cloneBoundedJsonObject(
    workflow.state,
    limits,
    RUNTIME_OWNED_CONTEXT_KEYS,
  );

  let extensionState: Record<string, unknown>;
  try {
    extensionState =
      options.extensionProvider?.validate(safeState) ?? safeState;
  } catch {
    throw validationFailure("Context extension rejected workflow state.");
  }
  const validatedExtensionState = cloneBoundedJsonObject(
    extensionState,
    limits,
    RUNTIME_OWNED_CONTEXT_KEYS,
  );

  const context: SkeinContext = {
    version: "1.0",
    revision: Number(record.revision),
    conversation: parseConversation(record.conversation),
    workflow: { state: validatedExtensionState },
    runtime: parseRuntime(record.runtime),
  };

  return cloneBoundedJsonObject(context, limits) as unknown as SkeinContext;
};

const parseProviderPatch = (
  value: unknown,
  limits: Readonly<ContextValidationLimits>,
): ContextPatch => {
  const record = cloneBoundedJsonObject(
    value,
    limits,
    RUNTIME_OWNED_CONTEXT_KEYS,
  );
  assertExactKeys(record, new Set(["conversation", "workflowState"]));

  const patch: ContextPatch = {};
  if (hasOwn(record, "conversation")) {
    patch.conversation = parseConversation(record.conversation);
  }
  if (hasOwn(record, "workflowState")) {
    patch.workflowState = cloneBoundedJsonObject(
      record.workflowState,
      limits,
      RUNTIME_OWNED_CONTEXT_KEYS,
    );
  }
  return patch;
};

class DefaultContextValidator implements ContextValidator {
  readonly limits: Readonly<ContextValidationLimits>;

  constructor(private readonly options: ContextValidationOptions) {
    this.limits = resolveLimits(options.limits);
  }

  validateContext(value: unknown): SkeinContext {
    try {
      return parseContext(value, this.options, this.limits);
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === RuntimeErrorCode.CONTEXT_INVALID
      ) {
        throw error;
      }
      throw contextInvalid(error);
    }
  }

  validateProviderPatch(value: unknown): ContextPatch {
    try {
      return parseProviderPatch(value, this.limits);
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === RuntimeErrorCode.PROVIDER_INVALID_RESPONSE
      ) {
        throw error;
      }
      throw providerPatchInvalid(error);
    }
  }
}

export const createContextValidator = (
  options: ContextValidationOptions = {},
): ContextValidator => new DefaultContextValidator(options);

export const validateSkeinContext = (
  value: unknown,
  options: ContextValidationOptions = {},
): SkeinContext => createContextValidator(options).validateContext(value);

export const validateProviderContextPatch = (
  value: unknown,
  limits?: ContextValidationLimits,
): ContextPatch =>
  createContextValidator(limits === undefined ? {} : { limits })
    .validateProviderPatch(value);
