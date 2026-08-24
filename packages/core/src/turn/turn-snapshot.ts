import type { ExecutionMode } from "@skein-chatbot/contracts";

import type { SkeinContext } from "../context/context.js";
import type { RuntimeMemoryContext } from "../memory/memory.js";
import type { RuntimeUserContext } from "../runtime/user-context.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface TurnSnapshot {
  readonly traceId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly query: string;
  readonly mode: ExecutionMode;
  readonly context: DeepReadonly<SkeinContext>;
  readonly memory: DeepReadonly<RuntimeMemoryContext>;
  readonly user: DeepReadonly<RuntimeUserContext>;
  readonly createdAt: string;
}

export interface TurnSnapshotInput {
  traceId: string;
  turnId: string;
  sessionId: string;
  query: string;
  mode: ExecutionMode;
  context: SkeinContext;
  memory: RuntimeMemoryContext;
  user: RuntimeUserContext;
  createdAt: string;
}

const freezeRecursively = (value: unknown, seen: WeakSet<object>): void => {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freezeRecursively(descriptor.value, seen);
    }
  }
  Object.freeze(value);
};

/** Runtime deep freeze for validated, cloneable domain values. */
export const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  freezeRecursively(value, new WeakSet<object>());
  return value as DeepReadonly<T>;
};

/**
 * Clones before freezing so an immutable snapshot never freezes or aliases the
 * mutable aggregate used to create it.
 */
export const createTurnSnapshot = (input: TurnSnapshotInput): TurnSnapshot =>
  deepFreeze(structuredClone(input));
