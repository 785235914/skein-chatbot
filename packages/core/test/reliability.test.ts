import { describe, expect, it, vi } from "vitest";

import {
  RuntimeError,
  RuntimeErrorCode,
  createAbortedError,
  type BusinessOrchestrator,
  type Clock,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
} from "../src/index.js";
import {
  CircuitBreakerRegistry,
  createReliableBusinessOrchestrator,
  type CircuitBreakerConfig,
  type ReliableBusinessOrchestratorOptions,
} from "../src/reliability/index.js";

interface PendingSleep {
  readonly dueAt: number;
  readonly milliseconds: number;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  resolve(): void;
  reject(error: unknown): void;
}

class ControlledClock implements Clock {
  readonly requestedSleeps: number[] = [];
  private currentMs = 0;
  private readonly pending = new Set<PendingSleep>();

  now(): Date {
    return new Date(this.currentMs);
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.requestedSleeps.push(milliseconds);
    if (signal?.aborted === true) {
      return Promise.reject(createAbortedError(signal.reason));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(sleeper);
        signal?.removeEventListener("abort", sleeper.onAbort);
        operation();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(createAbortedError(signal?.reason));
        });
      };
      const sleeper: PendingSleep = {
        dueAt: this.currentMs + milliseconds,
        milliseconds,
        signal,
        onAbort,
        resolve: () => {
          finish(resolve);
        },
        reject: (error) => {
          finish(() => {
            reject(error);
          });
        },
      };
      this.pending.add(sleeper);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  advance(milliseconds: number): void {
    this.currentMs += milliseconds;
    for (const sleeper of [...this.pending]) {
      if (sleeper.dueAt <= this.currentMs) {
        sleeper.resolve();
      }
    }
  }

  pendingDurations(): number[] {
    return [...this.pending].map(({ milliseconds }) => milliseconds);
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const deferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const result: OrchestrationResult = {
  answer: "Reliable answer",
  status: "ANSWER",
  sources: [],
};

const input = (mode: "QUICK" | "DEEP" = "QUICK"): OrchestrationInput => ({
  traceId: "trace-1",
  turnId: "turn-1",
  sessionId: "session-1",
  query: "Hello",
  mode,
  context: {
    version: "1.0",
    revision: 0,
    conversation: {},
    workflow: { state: {} },
    runtime: {},
  },
  memory: { recentMessages: [] },
  user: { userId: "user-1" },
});

const transient = (
  code: RuntimeErrorCode = RuntimeErrorCode.PROVIDER_UNAVAILABLE,
): RuntimeError =>
  new RuntimeError(code, "Safe transient provider failure.", {
    retryable: true,
  });

const orchestratorWithExecute = (
  execute: BusinessOrchestrator["execute"],
): BusinessOrchestrator => ({
  execute,
  stream: async function* (orchestrationInput, signal) {
    yield {
      type: "completed",
      result: await execute(orchestrationInput, signal),
    };
  },
});

interface ReliabilityOverrides {
  readonly providerKey?: string;
  readonly retryAttempts?: number;
  readonly quickTimeoutMs?: number;
  readonly deepTimeoutMs?: number;
  readonly retryBackoffMs?: number;
  readonly circuitBreakerRegistry?: CircuitBreakerRegistry;
  readonly circuitBreakerConfig?: CircuitBreakerConfig;
}

const reliable = (
  orchestrator: BusinessOrchestrator,
  clock: Clock,
  overrides: ReliabilityOverrides = {},
): BusinessOrchestrator => {
  const options: ReliableBusinessOrchestratorOptions = {
    orchestrator,
    providerKey: overrides.providerKey ?? "provider-a",
    config: {
      quickTimeoutMs: overrides.quickTimeoutMs ?? 1_000,
      deepTimeoutMs: overrides.deepTimeoutMs ?? 2_000,
      retryAttempts: overrides.retryAttempts ?? 0,
    },
    clock,
    retryBackoffMs: overrides.retryBackoffMs ?? 25,
    ...(overrides.circuitBreakerRegistry === undefined
      ? {}
      : { circuitBreakerRegistry: overrides.circuitBreakerRegistry }),
    ...(overrides.circuitBreakerConfig === undefined
      ? {}
      : { circuitBreakerConfig: overrides.circuitBreakerConfig }),
  };
  return createReliableBusinessOrchestrator(options);
};

const collect = async (
  iterable: AsyncIterable<OrchestrationEvent>,
): Promise<OrchestrationEvent[]> => {
  const events: OrchestrationEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

describe("ReliableBusinessOrchestrator timeout and retry", () => {
  it("enforces a blocking timeout even when the provider ignores abort", async () => {
    const clock = new ControlledClock();
    let receivedSignal: AbortSignal | undefined;
    const never = deferred<OrchestrationResult>();
    const execute = vi.fn((_input: OrchestrationInput, signal?: AbortSignal) => {
      receivedSignal = signal;
      return never.promise;
    });
    const operation = reliable(orchestratorWithExecute(execute), clock).execute(
      input(),
    );
    const observed = operation.catch((error: unknown) => error);

    await flush();
    expect(clock.pendingDurations()).toEqual([1_000]);
    clock.advance(999);
    await flush();
    expect(receivedSignal?.aborted).toBe(false);

    clock.advance(1);
    const failure = await observed;
    expect(failure).toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
      retryable: true,
      message: "The AI service took too long to respond.",
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("selects QUICK and DEEP timeout values from runtime configuration", async () => {
    const clock = new ControlledClock();
    const execute = vi.fn(async () => result);
    const decorated = reliable(orchestratorWithExecute(execute), clock, {
      quickTimeoutMs: 25_000,
      deepTimeoutMs: 60_000,
    });

    await decorated.execute(input("QUICK"));
    await decorated.execute(input("DEEP"));

    expect(clock.requestedSleeps).toEqual([25_000, 60_000]);
  });

  it("performs only the configured additional retry after backoff", async () => {
    const clock = new ControlledClock();
    const execute = vi
      .fn<BusinessOrchestrator["execute"]>()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(result);
    const operation = reliable(orchestratorWithExecute(execute), clock, {
      retryAttempts: 1,
      retryBackoffMs: 40,
    }).execute(input());

    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(clock.pendingDurations()).toEqual([40]);
    clock.advance(40);

    await expect(operation).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(clock.requestedSleeps).toEqual([1_000, 40, 1_000]);
  });

  it.each([
    RuntimeErrorCode.VALIDATION_ERROR,
    RuntimeErrorCode.INPUT_BLOCKED,
    RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    RuntimeErrorCode.ORCHESTRATION_FAILED,
    RuntimeErrorCode.OUTPUT_BLOCKED,
    RuntimeErrorCode.CONTEXT_INVALID,
    RuntimeErrorCode.ABORTED,
  ])("never retries the canonical non-transient error %s", async (code) => {
    const clock = new ControlledClock();
    const error = new RuntimeError(code, "Safe non-transient failure.", {
      retryable: true,
    });
    const execute = vi.fn(async () => {
      throw error;
    });

    await expect(
      reliable(orchestratorWithExecute(execute), clock, {
        retryAttempts: 2,
      }).execute(input()),
    ).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(clock.requestedSleeps).toEqual([1_000]);
  });

  it.each([
    RuntimeErrorCode.PROVIDER_UNAVAILABLE,
    RuntimeErrorCode.PROVIDER_RATE_LIMITED,
    RuntimeErrorCode.PROVIDER_TIMEOUT,
  ])("does not retry %s when the adapter marks it non-retryable", async (code) => {
    const clock = new ControlledClock();
    const error = new RuntimeError(code, "Safe provider rejection.");
    const execute = vi.fn(async () => {
      throw error;
    });

    await expect(
      reliable(orchestratorWithExecute(execute), clock, {
        retryAttempts: 2,
      }).execute(input()),
    ).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes an unknown provider failure without leaking its message", async () => {
    const clock = new ControlledClock();
    const execute = vi.fn(async () => {
      throw new Error("provider-payload-secret");
    });

    const failure = await reliable(
      orchestratorWithExecute(execute),
      clock,
      { retryAttempts: 1 },
    )
      .execute(input())
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: RuntimeErrorCode.ORCHESTRATION_FAILED,
      message: "The request could not be completed.",
      retryable: false,
    });
    expect(String((failure as Error).message)).not.toContain("secret");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("turns an external abort during a call into ABORTED", async () => {
    const clock = new ControlledClock();
    const controller = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const execute = vi.fn((_input: OrchestrationInput, signal?: AbortSignal) => {
      attemptSignal = signal;
      return deferred<OrchestrationResult>().promise;
    });
    const operation = reliable(orchestratorWithExecute(execute), clock).execute(
      input(),
      controller.signal,
    );
    const observed = operation.catch((error: unknown) => error);

    await flush();
    controller.abort("caller cancelled");

    await expect(observed).resolves.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
      retryable: false,
    });
    expect(attemptSignal?.aborted).toBe(true);
    expect(clock.pendingDurations()).toEqual([]);
  });

  it("aborts retry backoff and never opens another provider attempt", async () => {
    const clock = new ControlledClock();
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      throw transient();
    });
    const operation = reliable(orchestratorWithExecute(execute), clock, {
      retryAttempts: 1,
      retryBackoffMs: 75,
    }).execute(input(), controller.signal);
    const observed = operation.catch((error: unknown) => error);

    await flush();
    expect(clock.pendingDurations()).toEqual([75]);
    controller.abort("abort during backoff");

    await expect(observed).resolves.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("CircuitBreakerRegistry", () => {
  const breakerConfig: CircuitBreakerConfig = {
    failureThreshold: 1,
    cooldownMs: 100,
  };

  it("rejects an open circuit without calling the provider", async () => {
    const clock = new ControlledClock();
    const registry = new CircuitBreakerRegistry(breakerConfig);
    const execute = vi.fn(async () => {
      throw transient();
    });
    const decorated = reliable(orchestratorWithExecute(execute), clock, {
      circuitBreakerRegistry: registry,
    });

    await expect(decorated.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
    });
    await expect(decorated.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      retryable: true,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("provider-a")).toEqual({
      state: "OPEN",
      consecutiveFailures: 1,
      probeInFlight: false,
    });
  });

  it("closes after a successful half-open probe", async () => {
    const clock = new ControlledClock();
    const registry = new CircuitBreakerRegistry(breakerConfig);
    const execute = vi
      .fn<BusinessOrchestrator["execute"]>()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(result);
    const decorated = reliable(orchestratorWithExecute(execute), clock, {
      circuitBreakerRegistry: registry,
    });

    await expect(decorated.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    clock.advance(100);
    await expect(decorated.execute(input())).resolves.toBe(result);

    expect(registry.snapshot("provider-a")).toEqual({
      state: "CLOSED",
      consecutiveFailures: 0,
      probeInFlight: false,
    });
  });

  it("reopens and restarts cooldown after a failed half-open probe", async () => {
    const clock = new ControlledClock();
    const registry = new CircuitBreakerRegistry(breakerConfig);
    const execute = vi.fn(async () => {
      throw transient();
    });
    const decorated = reliable(orchestratorWithExecute(execute), clock, {
      circuitBreakerRegistry: registry,
    });

    await expect(decorated.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    clock.advance(100);
    await expect(decorated.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    clock.advance(99);
    await expect(decorated.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("isolates state by provider key in an explicitly shared registry", async () => {
    const clock = new ControlledClock();
    const registry = new CircuitBreakerRegistry(breakerConfig);
    const unavailable = reliable(
      orchestratorWithExecute(async () => {
        throw transient();
      }),
      clock,
      { providerKey: "provider-a", circuitBreakerRegistry: registry },
    );
    const healthyExecute = vi.fn(async () => result);
    const healthy = reliable(orchestratorWithExecute(healthyExecute), clock, {
      providerKey: "provider-b",
      circuitBreakerRegistry: registry,
    });

    await expect(unavailable.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(healthy.execute(input())).resolves.toBe(result);

    expect(registry.snapshot("provider-a").state).toBe("OPEN");
    expect(registry.snapshot("provider-b").state).toBe("CLOSED");
    expect(healthyExecute).toHaveBeenCalledTimes(1);
  });

  it("permits exactly one concurrent half-open probe", async () => {
    const clock = new ControlledClock();
    const registry = new CircuitBreakerRegistry(breakerConfig);
    const probe = deferred<OrchestrationResult>();
    const execute = vi
      .fn<BusinessOrchestrator["execute"]>()
      .mockRejectedValueOnce(transient())
      .mockImplementationOnce(() => probe.promise);
    const decorated = reliable(orchestratorWithExecute(execute), clock, {
      circuitBreakerRegistry: registry,
    });

    await expect(decorated.execute(input())).rejects.toBeInstanceOf(
      RuntimeError,
    );
    clock.advance(100);
    const firstProbe = decorated.execute(input());
    await flush();
    expect(registry.snapshot("provider-a")).toMatchObject({
      state: "HALF_OPEN",
      probeInFlight: true,
    });

    await expect(decorated.execute(input())).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      retryable: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);

    probe.resolve(result);
    await expect(firstProbe).resolves.toBe(result);
    expect(registry.snapshot("provider-a").state).toBe("CLOSED");
  });
});

describe("ReliableBusinessOrchestrator streaming", () => {
  it("retries a transient stream failure before the first event", async () => {
    const clock = new ControlledClock();
    const firstReturn = vi.fn(async (): Promise<IteratorResult<OrchestrationEvent>> => ({
      done: true,
      value: undefined,
    }));
    let streamCalls = 0;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: () => {
        streamCalls += 1;
        if (streamCalls === 1) {
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                throw transient();
              },
              return: firstReturn,
            }),
          };
        }
        return {
          [Symbol.asyncIterator]: () => ({
            next: vi
              .fn<AsyncIterator<OrchestrationEvent>["next"]>()
              .mockResolvedValueOnce({
                done: false,
                value: { type: "completed", result },
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        };
      },
    };
    const operation = collect(
      reliable(orchestrator, clock, {
        retryAttempts: 1,
        retryBackoffMs: 30,
      }).stream(input()),
    );

    await flush();
    expect(clock.pendingDurations()).toEqual([30]);
    clock.advance(30);

    await expect(operation).resolves.toEqual([
      { type: "completed", result },
    ]);
    expect(streamCalls).toBe(2);
    expect(firstReturn).toHaveBeenCalledTimes(1);
  });

  it("never retries after the first public orchestration event", async () => {
    const clock = new ControlledClock();
    let streamCalls = 0;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: async function* () {
        streamCalls += 1;
        yield { type: "delta", text: "already public" };
        throw transient();
      },
    };
    const events: OrchestrationEvent[] = [];

    const failure = await (async () => {
      try {
        for await (const event of reliable(orchestrator, clock, {
          retryAttempts: 2,
        }).stream(input())) {
          events.push(event);
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(events).toEqual([{ type: "delta", text: "already public" }]);
    expect(failure).toMatchObject({
      code: RuntimeErrorCode.PROVIDER_UNAVAILABLE,
    });
    expect(streamCalls).toBe(1);
    expect(clock.requestedSleeps).toEqual([1_000]);
  });

  it("times out a stalled stream and closes its iterator", async () => {
    const clock = new ControlledClock();
    const stalled = deferred<IteratorResult<OrchestrationEvent>>();
    const iteratorReturn = vi.fn(
      async (): Promise<IteratorResult<OrchestrationEvent>> => ({
        done: true,
        value: undefined,
      }),
    );
    let providerSignal: AbortSignal | undefined;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: (_input, signal) => {
        providerSignal = signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => stalled.promise,
            return: iteratorReturn,
          }),
        };
      },
    };
    const iterator = reliable(orchestrator, clock).stream(input())[
      Symbol.asyncIterator
    ]();
    const next = iterator.next();
    const observed = next.catch((error: unknown) => error);

    await flush();
    clock.advance(1_000);
    await expect(observed).resolves.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
      retryable: true,
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
  });

  it("does not pull another event after timeout while the consumer is paused", async () => {
    const clock = new ControlledClock();
    const iteratorReturn = vi.fn(
      async (): Promise<IteratorResult<OrchestrationEvent>> => ({
        done: true,
        value: undefined,
      }),
    );
    let nextCalls = 0;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<OrchestrationEvent>> => {
            nextCalls += 1;
            return {
              done: false,
              value: { type: "delta", text: "first" },
            };
          },
          return: iteratorReturn,
        }),
      }),
    };
    const iterator = reliable(orchestrator, clock).stream(input())[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "delta", text: "first" },
    });
    clock.advance(1_000);
    await flush();
    await expect(iterator.next()).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_TIMEOUT,
    });

    expect(nextCalls).toBe(1);
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled stream and closes its iterator", async () => {
    const clock = new ControlledClock();
    const controller = new AbortController();
    const stalled = deferred<IteratorResult<OrchestrationEvent>>();
    const iteratorReturn = vi.fn(
      async (): Promise<IteratorResult<OrchestrationEvent>> => ({
        done: true,
        value: undefined,
      }),
    );
    let providerSignal: AbortSignal | undefined;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: (_input, signal) => {
        providerSignal = signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => stalled.promise,
            return: iteratorReturn,
          }),
        };
      },
    };
    const iterator = reliable(orchestrator, clock).stream(
      input(),
      controller.signal,
    )[Symbol.asyncIterator]();
    const observed = iterator.next().catch((error: unknown) => error);

    await flush();
    controller.abort("caller cancelled stream");
    await expect(observed).resolves.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
  });

  it("cancels the provider signal and iterator when the consumer returns", async () => {
    const clock = new ControlledClock();
    const iteratorReturn = vi.fn(
      async (): Promise<IteratorResult<OrchestrationEvent>> => ({
        done: true,
        value: undefined,
      }),
    );
    let providerSignal: AbortSignal | undefined;
    let nextCalls = 0;
    const orchestrator: BusinessOrchestrator = {
      execute: async () => result,
      stream: (_input, signal) => {
        providerSignal = signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<OrchestrationEvent>> => {
              nextCalls += 1;
              return {
                done: false,
                value: { type: "delta", text: "first" },
              };
            },
            return: iteratorReturn,
          }),
        };
      },
    };
    const iterator = reliable(orchestrator, clock).stream(input())[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "delta", text: "first" },
    });
    await iterator.return?.();

    expect(nextCalls).toBe(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(iteratorReturn).toHaveBeenCalledTimes(1);
    expect(clock.pendingDurations()).toEqual([]);
  });
});
