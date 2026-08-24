import type { ExecutionMode } from "@skein-chatbot/contracts";

import type { RuntimeErrorCode } from "../errors/runtime-error.js";
import type { AuditEvent, AuditEventName, AuditPort } from "../ports/audit.js";
import type { Clock } from "../ports/clock.js";
import type {
  MetricKind,
  MetricMeasurement,
  MetricName,
  MetricsPort,
} from "../ports/metrics.js";
import type {
  TelemetryAttribute,
  TelemetryEvent,
  TelemetryPort,
  OperationalAttributes,
} from "../ports/telemetry.js";

export interface RuntimeObservationIdentity {
  readonly traceId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly mode: ExecutionMode;
  readonly startedAtMs: number;
}

export interface RuntimeObserverDependencies {
  readonly telemetry: TelemetryPort;
  readonly audit: AuditPort;
  readonly metrics: MetricsPort;
  readonly clock: Clock;
  readonly provider: string;
  readonly providerKey: string;
}

class ObservabilityPortFailure {
  constructor(readonly original: unknown) {}
}

const invokePort = (operation: () => void): void => {
  try {
    operation();
  } catch (error) {
    throw new ObservabilityPortFailure(error);
  }
};

export const isObservabilityPortFailure = (error: unknown): boolean =>
  error instanceof ObservabilityPortFailure;

export const unwrapObservabilityPortFailure = (error: unknown): unknown =>
  error instanceof ObservabilityPortFailure ? error.original : error;

const elapsedMilliseconds = (startedAtMs: number, endedAtMs: number): number =>
  Math.max(0, endedAtMs - startedAtMs);

const providerFailureCodes: ReadonlySet<RuntimeErrorCode> = new Set([
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_INVALID_RESPONSE",
  "ORCHESTRATION_FAILED",
] as RuntimeErrorCode[]);

const turnAttributes = (
  identity: RuntimeObservationIdentity,
  dependencies: Pick<RuntimeObserverDependencies, "provider" | "providerKey">,
): OperationalAttributes => ({
  turnId: identity.turnId,
  sessionId: identity.sessionId,
  provider: dependencies.provider,
  providerKey: dependencies.providerKey,
  mode: identity.mode,
});

export class RuntimeObserver {
  constructor(private readonly dependencies: RuntimeObserverDependencies) {}

  turnStarted(identity: RuntimeObservationIdentity): void {
    this.audit("TURN_STARTED", identity, this.dependencies.clock.now(), {
      status: "STARTED",
    });
  }

  turnCompleted(
    identity: RuntimeObservationIdentity,
    contextUpdated: boolean,
  ): void {
    const completed = this.dependencies.clock.now();
    const latencyMs = elapsedMilliseconds(
      identity.startedAtMs,
      completed.getTime(),
    );
    if (contextUpdated) {
      this.audit("CONTEXT_UPDATED", identity, completed, {
        status: "COMPLETED",
      });
    }
    const attributes = {
      ...turnAttributes(identity, this.dependencies),
      latencyMs,
      status: "COMPLETED",
    } as const;
    this.recordAudit({
      name: "TURN_COMPLETED",
      timestamp: completed.toISOString(),
      traceId: identity.traceId,
      attributes,
    });
    this.telemetry("TURN_COMPLETED", identity, completed, attributes);
    this.measure(
      "chat_turn_total",
      "counter",
      completed,
      1,
      { status: "COMPLETED", mode: identity.mode },
    );
    this.measure(
      "chat_turn_latency_ms",
      "histogram",
      completed,
      latencyMs,
      { status: "COMPLETED", mode: identity.mode },
    );
  }

  turnFailed(
    identity: RuntimeObservationIdentity,
    errorCode: RuntimeErrorCode,
  ): void {
    const failed = this.dependencies.clock.now();
    const latencyMs = elapsedMilliseconds(identity.startedAtMs, failed.getTime());
    const attributes = {
      ...turnAttributes(identity, this.dependencies),
      latencyMs,
      status: "FAILED",
      errorCode,
    } as const;
    this.recordAudit({
      name: "TURN_FAILED",
      timestamp: failed.toISOString(),
      traceId: identity.traceId,
      attributes,
    });
    this.telemetry("TURN_FAILED", identity, failed, attributes);
    this.measure("chat_turn_total", "counter", failed, 1, {
      status: "FAILED",
      mode: identity.mode,
      errorCode,
    });
    this.measure("chat_turn_latency_ms", "histogram", failed, latencyMs, {
      status: "FAILED",
      mode: identity.mode,
      errorCode,
    });
    if (providerFailureCodes.has(errorCode)) {
      this.measure("provider_error_total", "counter", failed, 1, {
        errorCode,
        provider: this.dependencies.provider,
        providerKey: this.dependencies.providerKey,
      });
    }
    if (errorCode === "SESSION_CONFLICT") {
      this.measure("context_conflict_total", "counter", failed, 1, {
        errorCode,
      });
    }
  }

  providerLatency(
    identity: RuntimeObservationIdentity,
    startedAtMs: number,
    status: "COMPLETED" | "FAILED",
  ): void {
    const completed = this.dependencies.clock.now();
    this.measure(
      "provider_latency_ms",
      "histogram",
      completed,
      elapsedMilliseconds(startedAtMs, completed.getTime()),
      {
        provider: this.dependencies.provider,
        providerKey: this.dependencies.providerKey,
        mode: identity.mode,
        status,
      },
    );
  }

  inputBlocked(identity: RuntimeObservationIdentity): void {
    const timestamp = this.dependencies.clock.now();
    this.audit("INPUT_BLOCKED", identity, timestamp, { phase: "INPUT" });
    this.measure("guard_block_total", "counter", timestamp, 1, {
      phase: "INPUT",
    });
  }

  inputRedacted(identity: RuntimeObservationIdentity): void {
    const timestamp = this.dependencies.clock.now();
    this.audit("INPUT_REDACTED", identity, timestamp, { phase: "INPUT" });
    this.measure("guard_redact_total", "counter", timestamp, 1, {
      phase: "INPUT",
    });
  }

  outputBlocked(identity: RuntimeObservationIdentity): void {
    const timestamp = this.dependencies.clock.now();
    this.audit("OUTPUT_BLOCKED", identity, timestamp, { phase: "OUTPUT" });
    this.measure("guard_block_total", "counter", timestamp, 1, {
      phase: "OUTPUT",
    });
  }

  outputRedacted(_identity: RuntimeObservationIdentity): void {
    const timestamp = this.dependencies.clock.now();
    this.measure("guard_redact_total", "counter", timestamp, 1, {
      phase: "OUTPUT",
    });
  }

  compacted(identity: RuntimeObservationIdentity): void {
    this.measure(
      "compaction_total",
      "counter",
      this.dependencies.clock.now(),
      1,
      { sessionId: identity.sessionId, status: "COMPACTED" },
    );
  }

  sessionReset(sessionId: string): void {
    const timestamp = this.dependencies.clock.now();
    this.recordAudit({
      name: "SESSION_RESET",
      timestamp: timestamp.toISOString(),
      attributes: { sessionId, status: "RESET" },
    });
  }

  private audit(
    name: AuditEventName,
    identity: RuntimeObservationIdentity,
    timestamp: Date,
    attributes: Readonly<OperationalAttributes>,
  ): void {
    this.recordAudit({
      name,
      timestamp: timestamp.toISOString(),
      traceId: identity.traceId,
      attributes: {
        ...turnAttributes(identity, this.dependencies),
        ...attributes,
      },
    });
  }

  private telemetry(
    name: TelemetryEvent["name"],
    identity: RuntimeObservationIdentity,
    timestamp: Date,
    attributes: Readonly<Record<string, TelemetryAttribute>>,
  ): void {
    this.recordTelemetry({
      name,
      timestamp: timestamp.toISOString(),
      traceId: identity.traceId,
      attributes,
    });
  }

  private measure(
    name: MetricName,
    kind: MetricKind,
    timestamp: Date,
    value: number,
    attributes?: MetricMeasurement["attributes"],
  ): void {
    this.recordMetric({
      name,
      kind,
      timestamp: timestamp.toISOString(),
      value,
      ...(attributes === undefined ? {} : { attributes }),
    });
  }

  private recordAudit(event: AuditEvent): void {
    invokePort(() => this.dependencies.audit.record(event));
  }

  private recordTelemetry(event: TelemetryEvent): void {
    invokePort(() => this.dependencies.telemetry.record(event));
  }

  private recordMetric(measurement: MetricMeasurement): void {
    invokePort(() => this.dependencies.metrics.record(measurement));
  }
}
