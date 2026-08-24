export type TelemetryAttribute = string | number | boolean;

export interface OperationalAttributes {
  readonly traceId?: string;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly providerKey?: string;
  readonly mode?: string;
  readonly phase?: "INPUT" | "OUTPUT";
  readonly status?: string;
  readonly errorCode?: string;
  readonly latencyMs?: number;
}

export interface TelemetryEvent {
  name: string;
  timestamp: string;
  traceId?: string;
  attributes?: Readonly<Record<string, TelemetryAttribute>>;
}

export interface TelemetryPort {
  record(event: TelemetryEvent): void;
}

export class NoopTelemetryPort implements TelemetryPort {
  record(_event: TelemetryEvent): void {}
}
