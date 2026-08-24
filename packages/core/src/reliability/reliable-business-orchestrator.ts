import type { RuntimeConfig } from "../config/runtime-config.js";
import {
  RuntimeError,
  RuntimeErrorCode,
  createAbortedError,
  throwIfAborted,
  toRuntimeError,
} from "../errors/runtime-error.js";
import type {
  BusinessOrchestrator,
  OrchestrationEvent,
  OrchestrationInput,
  OrchestrationResult,
} from "../orchestration/orchestration.js";
import type { Clock } from "../ports/clock.js";
import { SystemClock } from "../runtime/system-clock.js";
import { ProviderAttemptScope } from "./attempt-scope.js";
import {
  CircuitBreakerRegistry,
  type CircuitBreakerConfig,
  type CircuitBreakerLease,
} from "./circuit-breaker.js";
import { isRetryableProviderFailure } from "./retry-policy.js";

export const DEFAULT_RETRY_BACKOFF_MS = 100;

export type RuntimeReliabilityConfig = Pick<
  RuntimeConfig,
  "quickTimeoutMs" | "deepTimeoutMs" | "retryAttempts"
>;

export interface ReliableBusinessOrchestratorOptions {
  orchestrator: BusinessOrchestrator;
  providerKey: string;
  config: RuntimeReliabilityConfig;
  clock?: Clock;
  retryBackoffMs?: number;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  circuitBreakerConfig?: CircuitBreakerConfig;
}

const validateOptions = (
  options: ReliableBusinessOrchestratorOptions,
): void => {
  if (
    options.providerKey.trim().length === 0 ||
    !Number.isFinite(options.config.quickTimeoutMs) ||
    options.config.quickTimeoutMs < 1 ||
    !Number.isFinite(options.config.deepTimeoutMs) ||
    options.config.deepTimeoutMs < 1 ||
    !Number.isInteger(options.config.retryAttempts) ||
    options.config.retryAttempts < 0 ||
    (options.retryBackoffMs !== undefined &&
      (!Number.isFinite(options.retryBackoffMs) ||
        options.retryBackoffMs < 0)) ||
    (options.circuitBreakerRegistry !== undefined &&
      options.circuitBreakerConfig !== undefined)
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The reliability configuration is invalid.",
    );
  }
};

const closeIterator = async (
  iterator: AsyncIterator<OrchestrationEvent> | undefined,
): Promise<void> => {
  try {
    await iterator?.return?.();
  } catch {
    // Cleanup failures must not replace the provider or cancellation outcome.
  }
};

/** Provider-neutral timeout, retry, circuit-breaker and abort decorator. */
export class ReliableBusinessOrchestrator implements BusinessOrchestrator {
  private readonly clock: Clock;
  private readonly retryBackoffMs: number;
  private readonly breaker: CircuitBreakerRegistry;

  constructor(private readonly options: ReliableBusinessOrchestratorOptions) {
    validateOptions(options);
    this.clock = options.clock ?? new SystemClock();
    this.retryBackoffMs =
      options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.breaker =
      options.circuitBreakerRegistry ??
      new CircuitBreakerRegistry(options.circuitBreakerConfig);
  }

  async execute(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    const lease = this.acquire(signal);
    try {
      const result = await this.executeWithRetry(input, signal);
      lease.succeed();
      return result;
    } catch (error) {
      const runtimeError = this.canonicalError(error, signal);
      this.settleFailure(lease, runtimeError);
      throw runtimeError;
    }
  }

  async *stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent> {
    const lease = this.acquire(signal);
    let leaseSettled = false;

    try {
      for (
        let attemptIndex = 0;
        attemptIndex <= this.options.config.retryAttempts;
        attemptIndex += 1
      ) {
        const scope = new ProviderAttemptScope(
          this.clock,
          this.timeoutFor(input),
          signal,
        );
        let iterator: AsyncIterator<OrchestrationEvent> | undefined;
        let iteratorDone = false;
        let emitted = false;

        try {
          iterator = this.options.orchestrator.stream(input, scope.signal)[
            Symbol.asyncIterator
          ]();

          while (true) {
            const next = await scope.race(() => iterator!.next());
            if (next.done === true) {
              iteratorDone = true;
              if (!leaseSettled) {
                lease.succeed();
                leaseSettled = true;
              }
              return;
            }

            emitted = true;
            if (next.value.type === "completed" && !leaseSettled) {
              lease.succeed();
              leaseSettled = true;
            }
            yield next.value;
          }
        } catch (error) {
          const runtimeError = this.canonicalError(error, signal);
          const retry =
            !emitted &&
            attemptIndex < this.options.config.retryAttempts &&
            isRetryableProviderFailure(runtimeError);

          if (!retry) {
            if (!leaseSettled) {
              this.settleFailure(lease, runtimeError);
              leaseSettled = true;
            }
            throw runtimeError;
          }
        } finally {
          if (iteratorDone) {
            scope.close();
          } else {
            scope.cancel();
            await closeIterator(iterator);
          }
        }

        await this.backoff(signal);
      }
    } finally {
      if (!leaseSettled) {
        lease.release();
      }
    }
  }

  private async executeWithRetry(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    for (
      let attemptIndex = 0;
      attemptIndex <= this.options.config.retryAttempts;
      attemptIndex += 1
    ) {
      const scope = new ProviderAttemptScope(
        this.clock,
        this.timeoutFor(input),
        signal,
      );
      try {
        return await scope.race(() =>
          this.options.orchestrator.execute(input, scope.signal),
        );
      } catch (error) {
        const runtimeError = this.canonicalError(error, signal);
        if (
          attemptIndex >= this.options.config.retryAttempts ||
          !isRetryableProviderFailure(runtimeError)
        ) {
          throw runtimeError;
        }
      } finally {
        scope.close();
      }

      await this.backoff(signal);
    }

    throw new RuntimeError(
      RuntimeErrorCode.INTERNAL_ERROR,
      "The reliability retry loop ended unexpectedly.",
    );
  }

  private acquire(signal?: AbortSignal): CircuitBreakerLease {
    throwIfAborted(signal);
    try {
      const lease = this.breaker.acquire(
        this.options.providerKey,
        this.clock.now(),
      );
      throwIfAborted(signal);
      return lease;
    } catch (error) {
      throw this.canonicalError(error, signal);
    }
  }

  private async backoff(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      await this.clock.sleep(this.retryBackoffMs, signal);
      throwIfAborted(signal);
    } catch (error) {
      throw this.canonicalError(error, signal);
    }
  }

  private timeoutFor(input: OrchestrationInput): number {
    return input.mode === "DEEP"
      ? this.options.config.deepTimeoutMs
      : this.options.config.quickTimeoutMs;
  }

  private canonicalError(
    error: unknown,
    signal?: AbortSignal,
  ): RuntimeError {
    if (signal?.aborted === true) {
      return createAbortedError(signal.reason);
    }
    return toRuntimeError(error);
  }

  private settleFailure(
    lease: CircuitBreakerLease,
    error: RuntimeError,
  ): void {
    if (isRetryableProviderFailure(error)) {
      lease.fail(this.clock.now());
      return;
    }
    if (error.code === RuntimeErrorCode.ABORTED) {
      lease.release();
      return;
    }
    // A non-transient response does not indicate provider availability loss.
    lease.succeed();
  }
}

export const createReliableBusinessOrchestrator = (
  options: ReliableBusinessOrchestratorOptions,
): ReliableBusinessOrchestrator => new ReliableBusinessOrchestrator(options);
