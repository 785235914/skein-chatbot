import type { OperationalAttributes } from "./telemetry.js";

export const AUDIT_EVENT_NAMES = [
  "TURN_STARTED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "INPUT_BLOCKED",
  "INPUT_REDACTED",
  "OUTPUT_BLOCKED",
  "CONTEXT_UPDATED",
  "SESSION_RESET",
] as const;

export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

export interface AuditEvent {
  name: AuditEventName;
  timestamp: string;
  traceId?: string;
  attributes?: Readonly<OperationalAttributes>;
}

export interface AuditPort {
  record(event: AuditEvent): void;
}

export class NoopAuditPort implements AuditPort {
  record(_event: AuditEvent): void {}
}
