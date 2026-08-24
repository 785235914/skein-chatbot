import type { ContextValidationLimits } from "./context.js";

export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const RUNTIME_OWNED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "revision",
  "runtime",
  "lastTurnId",
  "updatedAt",
]);

export class ContextValueValidationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ContextValueValidationError";
  }
}

const fail = (message: string, cause?: unknown): never => {
  throw new ContextValueValidationError(
    message,
    cause === undefined ? {} : { cause },
  );
};

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneArray = (
  value: readonly unknown[],
  limits: Readonly<ContextValidationLimits>,
  forbiddenKeys: ReadonlySet<string>,
  depth: number,
  active: WeakSet<object>,
): unknown[] => {
  if (value.length > limits.maxArrayLength) {
    return fail("A context array exceeds the configured length limit.");
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    return fail("Context values may not contain symbol keys.");
  }
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    return fail("Context arrays must not be sparse or have custom properties.");
  }

  const clone: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail("Context arrays must contain ordinary JSON elements.");
    }
    clone.push(
      cloneJsonValue(
        descriptor.value,
        limits,
        forbiddenKeys,
        depth + 1,
        active,
      ),
    );
  }
  return clone;
};

const cloneObject = (
  value: object,
  limits: Readonly<ContextValidationLimits>,
  forbiddenKeys: ReadonlySet<string>,
  depth: number,
  active: WeakSet<object>,
): Record<string, unknown> => {
  if (!isPlainObject(value)) {
    return fail("Context values must use plain JSON objects.");
  }

  const clone: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      return fail("Context values may not contain symbol keys.");
    }
    if (UNSAFE_OBJECT_KEYS.has(key) || forbiddenKeys.has(key)) {
      return fail("Context values contain a reserved key.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail("Context objects must contain ordinary JSON properties.");
    }
    clone[key] = cloneJsonValue(
      descriptor.value,
      limits,
      forbiddenKeys,
      depth + 1,
      active,
    );
  }
  return clone;
};

const cloneJsonValue = (
  value: unknown,
  limits: Readonly<ContextValidationLimits>,
  forbiddenKeys: ReadonlySet<string>,
  depth: number,
  active: WeakSet<object>,
): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : fail("Context numbers must be finite.");
  }
  if (typeof value !== "object") {
    return fail("Context values must be JSON-compatible.");
  }
  if (depth > limits.maxObjectDepth) {
    return fail("Context values exceed the configured depth limit.");
  }
  if (active.has(value)) {
    return fail("Context values may not contain cycles.");
  }

  active.add(value);
  try {
    return Array.isArray(value)
      ? cloneArray(value, limits, forbiddenKeys, depth, active)
      : cloneObject(value, limits, forbiddenKeys, depth, active);
  } finally {
    active.delete(value);
  }
};

const serializedBytes = (value: Record<string, unknown>): number => {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
};

export const cloneBoundedJsonObject = (
  value: unknown,
  limits: Readonly<ContextValidationLimits>,
  forbiddenKeys: ReadonlySet<string> = new Set<string>(),
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("Context state must be a JSON object.");
  }

  let clone: unknown;
  try {
    clone = cloneJsonValue(value, limits, forbiddenKeys, 0, new WeakSet());
  } catch (error) {
    if (error instanceof ContextValueValidationError) {
      throw error;
    }
    return fail("Context values could not be inspected safely.", error);
  }
  if (
    typeof clone !== "object" ||
    clone === null ||
    Array.isArray(clone)
  ) {
    return fail("Context state must be a JSON object.");
  }
  if (
    serializedBytes(clone as Record<string, unknown>) >
    limits.maxSerializedBytes
  ) {
    return fail("Context exceeds the configured serialized size limit.");
  }
  return clone as Record<string, unknown>;
};
