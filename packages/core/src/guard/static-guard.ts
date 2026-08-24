import { throwIfAborted } from "../errors/runtime-error.js";
import type {
  GuardInput,
  GuardPort,
  GuardResult,
} from "../ports/guard.js";
import {
  normalizeGuardInput,
  resolveMaxTextLength,
  type GuardTextOptions,
} from "./text.js";

export abstract class NormalizedStaticGuard implements GuardPort {
  private readonly maxTextLength: number;

  protected constructor(options: GuardTextOptions = {}) {
    this.maxTextLength = resolveMaxTextLength(options);
  }

  async evaluate(
    input: GuardInput,
    signal?: AbortSignal,
  ): Promise<GuardResult> {
    throwIfAborted(signal);
    const normalizedInput = normalizeGuardInput(input, this.maxTextLength);
    const result = this.evaluateNormalized(normalizedInput);
    throwIfAborted(signal);
    return result;
  }

  protected abstract evaluateNormalized(input: GuardInput): GuardResult;
}
