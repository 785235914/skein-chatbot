import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

import {
  AUDIT_EVENT_NAMES,
  METRIC_NAMES,
  RuntimeErrorCode,
  type AuditEvent,
  type AuditPort,
  type MetricKind,
  type MetricMeasurement,
  type MetricsPort,
  type TelemetryAttribute,
  type TelemetryEvent,
  type TelemetryPort,
} from "@skein-chatbot/core";

export const PINO_LOG_LEVELS = [
  "silent",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;

export type PinoLogLevel = (typeof PINO_LOG_LEVELS)[number];

export type SanitizedObservabilityRecord = Readonly<
  Record<string, unknown>
>;

export interface OpenTelemetryCompatibleCallbacks {
  onTelemetry?(record: SanitizedObservabilityRecord): void;
  onAudit?(record: SanitizedObservabilityRecord): void;
  onMetric?(record: SanitizedObservabilityRecord): void;
}

export interface PinoObservabilityOptions {
  callbacks?: OpenTelemetryCompatibleCallbacks;
  destination?: DestinationStream;
  level?: string;
}

export interface PinoObservability {
  logger: Logger;
  telemetry: TelemetryPort;
  audit: AuditPort;
  metrics: MetricsPort;
}

const logLevels: ReadonlySet<string> = new Set(PINO_LOG_LEVELS);
const auditNames: ReadonlySet<string> = new Set(AUDIT_EVENT_NAMES);
const metricNames: ReadonlySet<string> = new Set(METRIC_NAMES);
const telemetryNames: ReadonlySet<string> = new Set([
  "TURN_COMPLETED",
  "TURN_FAILED",
]);
const genericEventNames: ReadonlySet<string> = new Set([
  ...AUDIT_EVENT_NAMES,
  ...METRIC_NAMES,
  ...telemetryNames,
  "TELEMETRY_EVENT",
  "OBSERVABILITY_CALLBACK_FAILED",
]);
const errorCodes: ReadonlySet<string> = new Set(Object.values(RuntimeErrorCode));
const modes: ReadonlySet<string> = new Set(["QUICK", "DEEP"]);
const phases: ReadonlySet<string> = new Set(["INPUT", "OUTPUT"]);
const statuses: ReadonlySet<string> = new Set([
  "STARTED",
  "COMPLETED",
  "FAILED",
  "RESET",
  "COMPACTED",
  "ANSWER",
  "PARTIAL",
  "NO_EVIDENCE",
  "HANDOFF",
]);
const safeMessages: ReadonlySet<string> = new Set([
  "Runtime event",
  "Audit event",
  "Metric measurement",
  "Observability callback failed",
  "incoming request",
  "request completed",
  "request errored",
  "API startup failed",
  "API cleanup after startup failure failed",
]);
const metricKinds: Readonly<Record<string, MetricKind>> = {
  chat_turn_total: "counter",
  chat_turn_latency_ms: "histogram",
  provider_latency_ms: "histogram",
  provider_error_total: "counter",
  guard_block_total: "counter",
  guard_redact_total: "counter",
  compaction_total: "counter",
  context_conflict_total: "counter",
};
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const methodPattern = /^[A-Z]{3,12}$/u;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const safeIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && identityPattern.test(value) ? value : undefined;

const safeTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
};

const safeNumber = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

const safePath = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const path = value.split(/[?#]/u, 1)[0];
  return path !== undefined && path.startsWith("/") && path.length <= 2_048
    ? path
    : undefined;
};

const compact = (
  record: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter((entry) => entry[1] !== undefined),
  );

const sanitizedAttributes = (
  value: unknown,
): Record<string, TelemetryAttribute> => {
  const attributes = asRecord(value);
  if (attributes === undefined) {
    return {};
  }
  return compact({
    traceId: safeIdentity(attributes.traceId),
    turnId: safeIdentity(attributes.turnId),
    sessionId: safeIdentity(attributes.sessionId),
    provider: safeIdentity(attributes.provider),
    providerKey: safeIdentity(attributes.providerKey),
    mode:
      typeof attributes.mode === "string" && modes.has(attributes.mode)
        ? attributes.mode
        : undefined,
    phase:
      typeof attributes.phase === "string" && phases.has(attributes.phase)
        ? attributes.phase
        : undefined,
    status:
      typeof attributes.status === "string" && statuses.has(attributes.status)
        ? attributes.status
        : undefined,
    errorCode:
      typeof attributes.errorCode === "string" &&
      errorCodes.has(attributes.errorCode)
        ? attributes.errorCode
        : undefined,
    latencyMs: safeNumber(attributes.latencyMs),
  }) as Record<string, TelemetryAttribute>;
};

const freezeRecord = (
  record: Record<string, unknown>,
): SanitizedObservabilityRecord => {
  const labels = asRecord(record.labels);
  return Object.freeze({
    ...record,
    ...(labels === undefined ? {} : { labels: Object.freeze({ ...labels }) }),
  });
};

const telemetryRecord = (
  event: TelemetryEvent,
): SanitizedObservabilityRecord => {
  const attributes = sanitizedAttributes(event.attributes);
  return freezeRecord(
    compact({
      channel: "runtime",
      event: telemetryNames.has(event.name) ? event.name : "TELEMETRY_EVENT",
      timestamp: safeTimestamp(event.timestamp),
      traceId: safeIdentity(event.traceId),
      ...attributes,
    }),
  );
};

const auditRecord = (
  event: AuditEvent,
): SanitizedObservabilityRecord | undefined => {
  if (!auditNames.has(event.name)) {
    return undefined;
  }
  return freezeRecord(
    compact({
      channel: "audit",
      event: event.name,
      timestamp: safeTimestamp(event.timestamp),
      traceId: safeIdentity(event.traceId),
      ...sanitizedAttributes(event.attributes),
    }),
  );
};

const metricRecord = (
  measurement: MetricMeasurement,
): SanitizedObservabilityRecord | undefined => {
  if (
    !metricNames.has(measurement.name) ||
    metricKinds[measurement.name] !== measurement.kind
  ) {
    return undefined;
  }
  const value = safeNumber(measurement.value);
  if (value === undefined) {
    return undefined;
  }
  return freezeRecord(
    compact({
      channel: "metrics",
      event: measurement.name,
      timestamp: safeTimestamp(measurement.timestamp),
      kind: measurement.kind,
      value,
      labels: sanitizedAttributes(measurement.attributes),
    }),
  );
};

const safeRequest = (value: unknown): Record<string, unknown> => {
  const request = asRecord(value);
  if (request === undefined) {
    return {};
  }
  return compact({
    id: safeIdentity(request.id),
    method:
      typeof request.method === "string" && methodPattern.test(request.method)
        ? request.method
        : undefined,
    url: safePath(request.url),
  });
};

const safeResponse = (value: unknown): Record<string, unknown> => {
  const response = asRecord(value);
  const statusCode = safeNumber(response?.statusCode);
  return statusCode === undefined ? {} : { statusCode };
};

const safeMessage = (value: unknown): string =>
  typeof value === "string" && safeMessages.has(value) ? value : "Log event";

const safeLogObject = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value);
  if (record === undefined) {
    return {};
  }
  const labels = sanitizedAttributes(record.labels);
  return compact({
    req: record.req,
    res: record.res,
    err: record.err === undefined ? undefined : {},
    channel:
      record.channel === "runtime" ||
      record.channel === "audit" ||
      record.channel === "metrics"
        ? record.channel
        : undefined,
    event:
      typeof record.event === "string" && genericEventNames.has(record.event)
        ? record.event
        : undefined,
    timestamp: safeTimestamp(record.timestamp),
    traceId: safeIdentity(record.traceId),
    turnId: safeIdentity(record.turnId),
    sessionId: safeIdentity(record.sessionId),
    provider: safeIdentity(record.provider),
    providerKey: safeIdentity(record.providerKey),
    mode:
      typeof record.mode === "string" && modes.has(record.mode)
        ? record.mode
        : undefined,
    phase:
      typeof record.phase === "string" && phases.has(record.phase)
        ? record.phase
        : undefined,
    status:
      typeof record.status === "string" && statuses.has(record.status)
        ? record.status
        : undefined,
    errorCode:
      typeof record.errorCode === "string" && errorCodes.has(record.errorCode)
        ? record.errorCode
        : undefined,
    latencyMs: safeNumber(record.latencyMs),
    responseTime: safeNumber(record.responseTime),
    kind:
      record.kind === "counter" || record.kind === "histogram"
        ? record.kind
        : undefined,
    value: safeNumber(record.value),
    labels: Object.keys(labels).length === 0 ? undefined : labels,
    code:
      record.code === "OBSERVABILITY_CALLBACK_FAILED"
        ? record.code
        : undefined,
    callback:
      record.callback === "telemetry" ||
      record.callback === "audit" ||
      record.callback === "metric"
        ? record.callback
        : undefined,
  });
};

const loggerOptions = (level: PinoLogLevel): LoggerOptions => ({
  level,
  // Pino accepts undefined at runtime, while its exact optional type omits it.
  base: undefined as unknown as null,
  formatters: {
    bindings: (bindings) =>
      compact({ reqId: safeIdentity(asRecord(bindings)?.reqId) }),
  },
  serializers: {
    req: safeRequest,
    res: safeResponse,
    err: () => ({}),
  },
  redact: {
    paths: [
      "authorization",
      "cookie",
      "body",
      "apiKey",
      "databaseUrl",
      "password",
      "token",
      "secret",
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body",
      "request.headers.authorization",
      "request.headers.cookie",
      "request.body",
      "headers.authorization",
      "headers.cookie",
      "*.authorization",
      "*.cookie",
      "*.body",
      "*.apiKey",
      "*.databaseUrl",
      "*.password",
      "*.token",
      "*.secret",
    ],
    remove: true,
  },
  hooks: {
    logMethod(args, method) {
      const first = args[0];
      if (typeof first === "object" && first !== null) {
        method.apply(this, [safeLogObject(first), safeMessage(args[1])]);
        return;
      }
      method.apply(this, [safeMessage(first)]);
    },
  },
});

const validatedLevel = (value: string | undefined): PinoLogLevel => {
  const level = value ?? "info";
  if (!logLevels.has(level)) {
    throw new TypeError("Unsupported log level.");
  }
  return level as PinoLogLevel;
};

export const createPinoObservability = (
  options: PinoObservabilityOptions = {},
): PinoObservability => {
  const logger = pino(
    loggerOptions(validatedLevel(options.level)),
    options.destination,
  );
  const callback = (
    name: "telemetry" | "audit" | "metric",
    operation: ((record: SanitizedObservabilityRecord) => void) | undefined,
    record: SanitizedObservabilityRecord,
  ): void => {
    if (operation === undefined) {
      return;
    }
    try {
      operation(record);
    } catch {
      logger.warn(
        {
          channel: "runtime",
          code: "OBSERVABILITY_CALLBACK_FAILED",
          callback: name,
        },
        "Observability callback failed",
      );
    }
  };

  return {
    logger,
    telemetry: {
      record: (event) => {
        const record = telemetryRecord(event);
        logger.info(record, "Runtime event");
        callback("telemetry", options.callbacks?.onTelemetry, record);
      },
    },
    audit: {
      record: (event) => {
        const record = auditRecord(event);
        if (record === undefined) {
          return;
        }
        logger.info(record, "Audit event");
        callback("audit", options.callbacks?.onAudit, record);
      },
    },
    metrics: {
      record: (measurement) => {
        const record = metricRecord(measurement);
        if (record === undefined) {
          return;
        }
        logger.info(record, "Metric measurement");
        callback("metric", options.callbacks?.onMetric, record);
      },
    },
  };
};
