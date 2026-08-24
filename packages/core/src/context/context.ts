/** Provider-neutral state owned by the Skein runtime. */
export interface SkeinContext {
  version: "1.0";
  revision: number;
  conversation: {
    topic?: string;
    language?: string;
  };
  workflow: {
    state: Record<string, unknown>;
  };
  runtime: {
    lastTurnId?: string;
    updatedAt?: string;
  };
}

/**
 * A provider may propose this bounded patch. The runtime remains responsible
 * for revision and runtime-owned fields.
 */
export interface ContextPatch {
  conversation?: Record<string, unknown>;
  workflowState?: Record<string, unknown>;
}

/** Optional application-owned validation for generic workflow state. */
export interface ContextExtensionProvider {
  validate(value: unknown): Record<string, unknown>;
}

/** Hard bounds applied to persisted context, provider patches, and extensions. */
export interface ContextValidationLimits {
  readonly maxSerializedBytes: number;
  readonly maxObjectDepth: number;
  readonly maxArrayLength: number;
}

export const DEFAULT_CONTEXT_VALIDATION_LIMITS: Readonly<ContextValidationLimits> =
  Object.freeze({
    maxSerializedBytes: 64 * 1024,
    maxObjectDepth: 16,
    maxArrayLength: 128,
  });

export interface ContextValidationOptions {
  readonly extensionProvider?: ContextExtensionProvider;
  readonly limits?: ContextValidationLimits;
}
