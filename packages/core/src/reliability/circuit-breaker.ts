import {
  RuntimeError,
  RuntimeErrorCode,
} from "../errors/runtime-error.js";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig =
  Object.freeze({
    failureThreshold: 3,
    cooldownMs: 30_000,
  });

interface CircuitEntry {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAtMs: number | undefined;
  probeInFlight: boolean;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitBreakerState;
  readonly consecutiveFailures: number;
  readonly probeInFlight: boolean;
}

export interface CircuitBreakerLease {
  succeed(): void;
  fail(now: Date): void;
  release(): void;
}

const openError = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_UNAVAILABLE,
    "The AI service is temporarily unavailable.",
    { retryable: true },
  );

const validateConfig = (config: CircuitBreakerConfig): void => {
  if (
    !Number.isInteger(config.failureThreshold) ||
    config.failureThreshold < 1 ||
    !Number.isFinite(config.cooldownMs) ||
    config.cooldownMs < 0
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The circuit breaker configuration is invalid.",
    );
  }
};

const timestamp = (value: Date): number => {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RuntimeError(
      RuntimeErrorCode.INTERNAL_ERROR,
      "The reliability clock returned an invalid time.",
    );
  }
  return milliseconds;
};

/** Mutable state is instance-scoped and may be explicitly shared by compositions. */
export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, CircuitEntry>();

  constructor(
    private readonly config: CircuitBreakerConfig =
      DEFAULT_CIRCUIT_BREAKER_CONFIG,
  ) {
    validateConfig(config);
  }

  acquire(providerKey: string, now: Date): CircuitBreakerLease {
    const currentTime = timestamp(now);
    const entry = this.entry(providerKey);

    if (entry.state === "OPEN") {
      const openedAt = entry.openedAtMs ?? currentTime;
      if (currentTime - openedAt < this.config.cooldownMs) {
        throw openError();
      }
      entry.state = "HALF_OPEN";
      entry.probeInFlight = false;
    }

    const probe = entry.state === "HALF_OPEN";
    if (probe) {
      if (entry.probeInFlight) {
        throw openError();
      }
      entry.probeInFlight = true;
    }

    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      operation();
    };

    return {
      succeed: () => {
        settle(() => {
          entry.state = "CLOSED";
          entry.consecutiveFailures = 0;
          entry.openedAtMs = undefined;
          entry.probeInFlight = false;
        });
      },
      fail: (failedAt) => {
        settle(() => {
          entry.probeInFlight = false;
          entry.consecutiveFailures = probe
            ? this.config.failureThreshold
            : entry.consecutiveFailures + 1;
          if (
            probe ||
            entry.consecutiveFailures >= this.config.failureThreshold
          ) {
            entry.state = "OPEN";
            entry.openedAtMs = timestamp(failedAt);
          }
        });
      },
      release: () => {
        settle(() => {
          if (probe && entry.state === "HALF_OPEN") {
            entry.probeInFlight = false;
          }
        });
      },
    };
  }

  snapshot(providerKey: string): CircuitBreakerSnapshot {
    const entry = this.entry(providerKey);
    return Object.freeze({
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      probeInFlight: entry.probeInFlight,
    });
  }

  private entry(providerKey: string): CircuitEntry {
    if (providerKey.trim().length === 0) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The reliability provider key is invalid.",
      );
    }
    const existing = this.entries.get(providerKey);
    if (existing !== undefined) {
      return existing;
    }
    const created: CircuitEntry = {
      state: "CLOSED",
      consecutiveFailures: 0,
      openedAtMs: undefined,
      probeInFlight: false,
    };
    this.entries.set(providerKey, created);
    return created;
  }
}
