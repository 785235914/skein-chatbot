import type { OperationalAttributes } from "./telemetry.js";

export const METRIC_NAMES = [
  "chat_turn_total",
  "chat_turn_latency_ms",
  "provider_latency_ms",
  "provider_error_total",
  "guard_block_total",
  "guard_redact_total",
  "compaction_total",
  "context_conflict_total",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];
export type MetricKind = "counter" | "histogram";

export interface MetricMeasurement {
  name: MetricName;
  kind: MetricKind;
  timestamp: string;
  value: number;
  attributes?: Readonly<OperationalAttributes>;
}

export interface MetricsPort {
  record(measurement: MetricMeasurement): void;
}

export class NoopMetricsPort implements MetricsPort {
  record(_measurement: MetricMeasurement): void {}
}
