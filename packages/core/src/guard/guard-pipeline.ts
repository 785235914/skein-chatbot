import {
  createAbortedError,
  isRuntimeError,
  RuntimeErrorCode,
  throwIfAborted,
} from "../errors/runtime-error.js";
import type {
  GuardInput,
  GuardPort,
  GuardResult,
} from "../ports/guard.js";
import { validateGuardResult } from "./result.js";
import {
  guardValidationError,
  normalizeGuardInput,
  resolveMaxTextLength,
  type GuardTextOptions,
} from "./text.js";

export type GuardPipelineOptions = GuardTextOptions;

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

const appendUnique = (target: string[], values: readonly string[]): void => {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
};

const terminalResult = (
  result: GuardResult,
  riskTypes: string[],
): GuardResult => {
  const terminal: GuardResult = {
    action: result.action,
    safe: false,
    riskTypes,
  };
  if (result.reason !== undefined) {
    terminal.reason = result.reason;
  }
  return terminal;
};

export class GuardPipeline implements GuardPort {
  private readonly stages: readonly GuardPort[];
  private readonly maxTextLength: number;

  constructor(
    stages: readonly GuardPort[],
    options: GuardPipelineOptions = {},
  ) {
    this.maxTextLength = resolveMaxTextLength(options);
    if (
      !Array.isArray(stages) ||
      !stages.every(
        (stage) =>
          typeof stage === "object" &&
          stage !== null &&
          typeof stage.evaluate === "function",
      )
    ) {
      throw guardValidationError();
    }
    this.stages = Object.freeze([...stages]);
  }

  async evaluate(
    input: GuardInput,
    signal?: AbortSignal,
  ): Promise<GuardResult> {
    throwIfAborted(signal);
    let currentInput = normalizeGuardInput(input, this.maxTextLength);
    const riskTypes: string[] = [];
    let lastRedaction: GuardResult | undefined;

    for (const stage of this.stages) {
      throwIfAborted(signal);
      let rawResult: unknown;
      try {
        rawResult = await stage.evaluate(currentInput, signal);
      } catch (error) {
        if (
          isRuntimeError(error) &&
          error.code === RuntimeErrorCode.ABORTED
        ) {
          throw error;
        }
        if (signal?.aborted === true || isAbortError(error)) {
          throw createAbortedError(error);
        }
        throw error;
      }
      throwIfAborted(signal);

      const result = validateGuardResult(
        rawResult,
        currentInput.text,
        this.maxTextLength,
      );
      appendUnique(riskTypes, result.riskTypes);

      if (result.action === "BLOCK" || result.action === "REVIEW") {
        return terminalResult(result, riskTypes);
      }

      if (result.action === "REDACT") {
        currentInput = {
          ...currentInput,
          text: result.sanitizedText!,
        };
        lastRedaction = result;
      }
    }

    if (lastRedaction !== undefined) {
      const result: GuardResult = {
        action: "REDACT",
        safe: true,
        riskTypes,
        sanitizedText: currentInput.text,
      };
      if (lastRedaction.reason !== undefined) {
        result.reason = lastRedaction.reason;
      }
      return result;
    }

    return { action: "ALLOW", safe: true, riskTypes };
  }
}
