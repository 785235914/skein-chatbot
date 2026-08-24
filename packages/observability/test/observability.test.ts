import { describe, expect, it, vi } from "vitest";

import type {
  AuditEvent,
  MetricMeasurement,
  TelemetryEvent,
} from "@skein-chatbot/core";

import { createPinoObservability } from "../src/index.js";

const destination = (): {
  lines: Record<string, unknown>[];
  stream: { write(chunk: string): void };
} => {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(chunk) {
        for (const line of chunk.split("\n").filter(Boolean)) {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
    },
  };
};

const sortedKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value).sort();

describe("Pino observability", () => {
  it("emits exact safe runtime, audit and metric channels", () => {
    const output = destination();
    const observability = createPinoObservability({ destination: output.stream });

    observability.telemetry.record({
      name: "TURN_COMPLETED",
      timestamp: "2026-01-01T00:00:00.010Z",
      traceId: "trace-1",
      attributes: {
        turnId: "turn-1",
        sessionId: "session-1",
        provider: "mock",
        providerKey: "tenant-a:default",
        mode: "QUICK",
        latencyMs: 10,
        status: "COMPLETED",
      },
    });
    observability.audit.record({
      name: "INPUT_REDACTED",
      timestamp: "2026-01-01T00:00:00.005Z",
      traceId: "trace-1",
      attributes: { turnId: "turn-1", sessionId: "session-1", phase: "INPUT" },
    });
    observability.metrics.record({
      name: "chat_turn_latency_ms",
      kind: "histogram",
      timestamp: "2026-01-01T00:00:00.010Z",
      value: 10,
      attributes: { provider: "mock", mode: "QUICK", status: "COMPLETED" },
    });

    expect(output.lines).toHaveLength(3);
    expect(output.lines.map((line) => line.channel)).toEqual([
      "runtime",
      "audit",
      "metrics",
    ]);
    expect(sortedKeys(output.lines[0]!)).toEqual([
      "channel",
      "event",
      "latencyMs",
      "level",
      "mode",
      "msg",
      "provider",
      "providerKey",
      "sessionId",
      "status",
      "time",
      "timestamp",
      "traceId",
      "turnId",
    ]);
    expect(output.lines[0]).toMatchObject({
      channel: "runtime",
      event: "TURN_COMPLETED",
      traceId: "trace-1",
      turnId: "turn-1",
      latencyMs: 10,
    });
    expect(sortedKeys(output.lines[1]!)).toEqual([
      "channel",
      "event",
      "level",
      "msg",
      "phase",
      "sessionId",
      "time",
      "timestamp",
      "traceId",
      "turnId",
    ]);
    expect(output.lines[1]).toMatchObject({
      channel: "audit",
      event: "INPUT_REDACTED",
      phase: "INPUT",
    });
    expect(sortedKeys(output.lines[2]!)).toEqual([
      "channel",
      "event",
      "kind",
      "labels",
      "level",
      "msg",
      "time",
      "timestamp",
      "value",
    ]);
    expect(sortedKeys(output.lines[2]!.labels as Record<string, unknown>))
      .toEqual(["mode", "provider", "status"]);
    expect(output.lines[2]).toMatchObject({
      channel: "metrics",
      event: "chat_turn_latency_ms",
      kind: "histogram",
      value: 10,
      labels: { provider: "mock", mode: "QUICK", status: "COMPLETED" },
    });
    for (const line of output.lines) {
      expect(line).not.toHaveProperty("pid");
      expect(line).not.toHaveProperty("hostname");
    }
  });

  it("drops hostile values supplied under every accepted generic log field", () => {
    const secret = "generic-field-secret-must-not-leak";
    const invalidIdentity = `${secret} invalid`;
    const output = destination();
    const observability = createPinoObservability({ destination: output.stream });

    observability.logger.info(
      {
        req: {
          id: invalidIdentity,
          method: secret,
          url: `/safe?query=${secret}`,
          headers: { authorization: secret, cookie: secret },
          body: { message: secret },
        },
        res: { statusCode: secret, body: secret },
        err: new Error(secret),
        channel: secret,
        event: secret,
        timestamp: secret,
        traceId: invalidIdentity,
        turnId: invalidIdentity,
        sessionId: invalidIdentity,
        provider: invalidIdentity,
        providerKey: invalidIdentity,
        mode: secret,
        phase: secret,
        status: secret,
        errorCode: secret,
        latencyMs: secret,
        responseTime: secret,
        kind: secret,
        value: secret,
        labels: {
          traceId: invalidIdentity,
          turnId: invalidIdentity,
          sessionId: invalidIdentity,
          provider: invalidIdentity,
          providerKey: invalidIdentity,
          mode: secret,
          phase: secret,
          status: secret,
          errorCode: secret,
          latencyMs: secret,
        },
        code: secret,
        callback: secret,
      },
      secret,
    );

    expect(output.lines).toHaveLength(1);
    expect(JSON.stringify(output.lines)).not.toContain(secret);
    expect(sortedKeys(output.lines[0]!)).toEqual([
      "err",
      "level",
      "msg",
      "req",
      "res",
      "time",
    ]);
    expect(output.lines[0]).toMatchObject({
      err: {},
      msg: "Log event",
      req: { url: "/safe" },
      res: {},
    });
    expect(sortedKeys(output.lines[0]!.req as Record<string, unknown>)).toEqual([
      "url",
    ]);
    expect(sortedKeys(output.lines[0]!.res as Record<string, unknown>)).toEqual([]);
  });

  it("drops hostile unknown fields and redacts logger request paths", () => {
    const secret = "hostile-secret-must-not-leak";
    const output = destination();
    const observability = createPinoObservability({ destination: output.stream });

    observability.telemetry.record({
      name: "TURN_FAILED",
      timestamp: "2026-01-01T00:00:00.000Z",
      traceId: "trace-1",
      attributes: {
        status: "FAILED",
        errorCode: "ORCHESTRATION_FAILED",
        query: secret,
        answer: secret,
        context: secret,
        metadata: secret,
        url: `https://example.com/?token=${secret}`,
      },
    } as TelemetryEvent);
    observability.audit.record({
      name: "TURN_FAILED",
      timestamp: "2026-01-01T00:00:00.000Z",
      attributes: { cause: new Error(secret), body: { token: secret } },
    } as unknown as AuditEvent);
    observability.metrics.record({
      name: "provider_error_total",
      kind: "counter",
      timestamp: "2026-01-01T00:00:00.000Z",
      value: 1,
      attributes: { apiKey: secret, error: new Error(secret) },
    } as unknown as MetricMeasurement);
    observability.logger.info(
      {
        event: secret,
        req: {
          id: "request-1",
          method: "POST",
          url: `/api/v1/chat?query=${secret}`,
          headers: { authorization: `Bearer ${secret}`, cookie: secret },
          body: { message: secret },
        },
        err: new Error(secret),
        response: { providerResponse: secret },
      },
      secret,
    );

    const serialized = JSON.stringify(output.lines);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/query|answer|context|metadata|apiKey|cause|body/u);
    expect(output.lines.at(-1)).toMatchObject({
      req: { id: "request-1", method: "POST", url: "/api/v1/chat" },
    });
  });

  it("forwards frozen sanitized callback records for counters and histograms", () => {
    const output = destination();
    const onTelemetry = vi.fn();
    const onAudit = vi.fn();
    const onMetric = vi.fn();
    const observability = createPinoObservability({
      destination: output.stream,
      callbacks: { onTelemetry, onAudit, onMetric },
    });

    observability.telemetry.record({
      name: "TURN_COMPLETED",
      timestamp: "2026-01-01T00:00:00.000Z",
      traceId: "trace-1",
      attributes: { status: "COMPLETED", unknown: "drop-me" },
    });
    observability.audit.record({
      name: "SESSION_RESET",
      timestamp: "2026-01-01T00:00:00.000Z",
      attributes: { sessionId: "session-1", status: "RESET" },
    });
    observability.metrics.record({
      name: "chat_turn_total",
      kind: "counter",
      timestamp: "2026-01-01T00:00:00.000Z",
      value: 1,
      attributes: { status: "COMPLETED" },
    });

    for (const callback of [onTelemetry, onAudit, onMetric]) {
      expect(callback).toHaveBeenCalledOnce();
      expect(Object.isFrozen(callback.mock.calls[0]?.[0])).toBe(true);
      expect(JSON.stringify(callback.mock.calls[0]?.[0])).not.toContain("drop-me");
    }
    const telemetryRecord = onTelemetry.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const auditRecord = onAudit.mock.calls[0]![0] as Record<string, unknown>;
    const metricRecord = onMetric.mock.calls[0]![0] as Record<string, unknown>;
    expect(sortedKeys(telemetryRecord)).toEqual([
      "channel",
      "event",
      "status",
      "timestamp",
      "traceId",
    ]);
    expect(sortedKeys(auditRecord)).toEqual([
      "channel",
      "event",
      "sessionId",
      "status",
      "timestamp",
    ]);
    expect(sortedKeys(metricRecord)).toEqual([
      "channel",
      "event",
      "kind",
      "labels",
      "timestamp",
      "value",
    ]);
    expect(sortedKeys(metricRecord.labels as Record<string, unknown>)).toEqual([
      "status",
    ]);
    expect(Object.isFrozen(metricRecord.labels)).toBe(true);
    expect(sortedKeys(output.lines[2]!)).toEqual([
      "channel",
      "event",
      "kind",
      "labels",
      "level",
      "msg",
      "time",
      "timestamp",
      "value",
    ]);
    expect(sortedKeys(output.lines[2]!.labels as Record<string, unknown>))
      .toEqual(["status"]);
  });

  it("contains callback failures behind one fixed warning", () => {
    const secret = "callback-error-secret";
    const output = destination();
    const observability = createPinoObservability({
      destination: output.stream,
      callbacks: {
        onMetric: () => {
          throw new Error(secret);
        },
      },
    });

    expect(() =>
      observability.metrics.record({
        name: "provider_error_total",
        kind: "counter",
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 1,
      }),
    ).not.toThrow();
    expect(output.lines.at(-1)).toMatchObject({
      channel: "runtime",
      code: "OBSERVABILITY_CALLBACK_FAILED",
      callback: "metric",
      msg: "Observability callback failed",
    });
    expect(sortedKeys(output.lines.at(-1)!)).toEqual([
      "callback",
      "channel",
      "code",
      "level",
      "msg",
      "time",
    ]);
    expect(JSON.stringify(output.lines)).not.toContain(secret);
  });

  it.each(["silent", "trace", "debug", "info", "warn", "error", "fatal"])(
    "accepts the validated %s level",
    (level) => {
      expect(() => createPinoObservability({ level })).not.toThrow();
    },
  );

  it("rejects an unvalidated logger level", () => {
    expect(() => createPinoObservability({ level: "everything" })).toThrow(
      "Unsupported log level.",
    );
  });
});
