import { describe, expect, it } from "vitest";

import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  RuntimeError,
  RuntimeErrorCode,
  type AuditEvent,
  type AuditPort,
  type BusinessOrchestrator,
  type GuardPort,
  type MetricMeasurement,
  type MetricsPort,
  type OrchestrationInput,
  type OrchestrationResult,
  type RuntimeStore,
  type TelemetryEvent,
  type TelemetryPort,
} from "@skein-chatbot/core";
import {
  InMemoryRuntimeStore,
  ManualClock,
  SequenceIdGenerator,
} from "@skein-chatbot/test-utils";

const successResult = (answer = "safe answer"): OrchestrationResult => ({
  answer,
  status: "ANSWER",
  sources: [],
});

class RecordingObservability {
  readonly telemetryEvents: TelemetryEvent[] = [];
  readonly auditEvents: AuditEvent[] = [];
  readonly measurements: MetricMeasurement[] = [];

  readonly telemetry: TelemetryPort = {
    record: (event) => this.telemetryEvents.push(structuredClone(event)),
  };

  readonly audit: AuditPort = {
    record: (event) => this.auditEvents.push(structuredClone(event)),
  };

  readonly metrics: MetricsPort = {
    record: (measurement) =>
      this.measurements.push(structuredClone(measurement)),
  };

  clear(): void {
    this.telemetryEvents.splice(0);
    this.auditEvents.splice(0);
    this.measurements.splice(0);
  }
}

const createRuntime = (
  orchestrator: BusinessOrchestrator,
  options: {
    inputGuard?: GuardPort;
    observability?: RecordingObservability;
    outputGuard?: GuardPort;
    store?: RuntimeStore;
    threshold?: number;
  } = {},
): {
  clock: ManualClock;
  observability: RecordingObservability;
  runtime: ChatRuntime;
  store: RuntimeStore;
} => {
  const clock = new ManualClock();
  const observability = options.observability ?? new RecordingObservability();
  const store = options.store ?? new InMemoryRuntimeStore();
  return {
    clock,
    observability,
    runtime: new ChatRuntime({
      orchestrator,
      store,
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        compactionMessageThreshold: options.threshold ?? 20,
        recentMessages: options.threshold === undefined ? 8 : 0,
      },
      provider: "mock",
      providerKey: "tenant-a:default",
      clock,
      idGenerator: new SequenceIdGenerator([
        "trace-1",
        "turn-1",
        "session-1",
        "user-message-1",
        "assistant-message-1",
        "trace-2",
        "turn-2",
        "unused-session-2",
        "user-message-2",
        "assistant-message-2",
      ]),
      telemetry: observability.telemetry,
      audit: observability.audit,
      metrics: observability.metrics,
      ...(options.inputGuard === undefined
        ? {}
        : { inputGuard: options.inputGuard }),
      ...(options.outputGuard === undefined
        ? {}
        : { outputGuard: options.outputGuard }),
    }),
    store,
  };
};

const executeOnly = (
  execute: (input: OrchestrationInput) => Promise<OrchestrationResult>,
): BusinessOrchestrator => ({
  execute,
  stream: async function* (input) {
    yield { type: "completed", result: await execute(input) };
  },
});

const metric = (
  measurements: readonly MetricMeasurement[],
  name: MetricMeasurement["name"],
): MetricMeasurement[] =>
  measurements.filter((measurement) => measurement.name === name);

describe("Runtime observability", () => {
  it("emits one safe blocking start/completion and canonical measurements", async () => {
    const secret = "query-secret-must-not-leak";
    const runtimeSetup = createRuntime(
      executeOnly((input) => {
        runtimeSetup.clock.advance(25);
        return Promise.resolve(successResult(`answer for ${input.query}`));
      }),
    );

    const response = await runtimeSetup.runtime.chat({
      message: secret,
      user: { userId: "user-1" },
    });

    expect(response.status).toBe("ANSWER");
    expect(runtimeSetup.observability.auditEvents).toEqual([
      {
        name: "TURN_STARTED",
        timestamp: "2026-01-01T00:00:00.000Z",
        traceId: "trace-1",
        attributes: {
          turnId: "turn-1",
          sessionId: "session-1",
          provider: "mock",
          providerKey: "tenant-a:default",
          mode: "QUICK",
          status: "STARTED",
        },
      },
      {
        name: "TURN_COMPLETED",
        timestamp: "2026-01-01T00:00:00.025Z",
        traceId: "trace-1",
        attributes: {
          turnId: "turn-1",
          sessionId: "session-1",
          provider: "mock",
          providerKey: "tenant-a:default",
          mode: "QUICK",
          latencyMs: 25,
          status: "COMPLETED",
        },
      },
    ]);
    expect(runtimeSetup.observability.telemetryEvents).toEqual([
      {
        name: "TURN_COMPLETED",
        timestamp: "2026-01-01T00:00:00.025Z",
        traceId: "trace-1",
        attributes: {
          turnId: "turn-1",
          sessionId: "session-1",
          provider: "mock",
          providerKey: "tenant-a:default",
          mode: "QUICK",
          latencyMs: 25,
          status: "COMPLETED",
        },
      },
    ]);
    expect(metric(runtimeSetup.observability.measurements, "provider_latency_ms"))
      .toEqual([
        expect.objectContaining({ kind: "histogram", value: 25 }),
      ]);
    expect(metric(runtimeSetup.observability.measurements, "chat_turn_total"))
      .toEqual([expect.objectContaining({ kind: "counter", value: 1 })]);
    expect(metric(runtimeSetup.observability.measurements, "chat_turn_latency_ms"))
      .toEqual([
        expect.objectContaining({ kind: "histogram", value: 25 }),
      ]);
    expect(JSON.stringify(runtimeSetup.observability)).not.toContain(secret);
    expect(JSON.stringify(runtimeSetup.observability)).not.toContain(
      "answer for",
    );
  });

  it("uses the same single terminal observability contract for streaming", async () => {
    const observability = new RecordingObservability();
    const clock = new ManualClock();
    const orchestrator: BusinessOrchestrator = {
      execute: () => Promise.resolve(successResult()),
      stream: async function* () {
        clock.advance(7);
        yield { type: "delta", text: "stream-secret-answer" };
        yield { type: "completed", result: successResult("stream-secret-answer") };
      },
    };
    const runtime = new ChatRuntime({
      orchestrator,
      store: new InMemoryRuntimeStore(),
      config: DEFAULT_RUNTIME_CONFIG,
      provider: "mock",
      providerKey: "default",
      clock,
      idGenerator: new SequenceIdGenerator([
        "trace-stream",
        "turn-stream",
        "session-stream",
        "user-stream",
        "assistant-stream",
      ]),
      telemetry: observability.telemetry,
      audit: observability.audit,
      metrics: observability.metrics,
    });

    const publicEvents = [];
    for await (const event of runtime.stream({
      message: "stream-query-secret",
      user: { userId: "user-1" },
    })) {
      publicEvents.push(event);
    }

    expect(publicEvents.at(-1)?.type).toBe("turn.completed");
    expect(observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "TURN_COMPLETED",
    ]);
    expect(observability.telemetryEvents.map((event) => event.name)).toEqual([
      "TURN_COMPLETED",
    ]);
    expect(metric(observability.measurements, "chat_turn_total")).toHaveLength(1);
    expect(JSON.stringify(observability)).not.toMatch(/stream-(query|secret-answer)/u);
  });

  it("counts one logical streaming output redaction exactly once", async () => {
    const unsafeAnswer = "stream-unsafe-output";
    const orchestrator: BusinessOrchestrator = {
      execute: () => Promise.resolve(successResult(unsafeAnswer)),
      stream: async function* () {
        yield { type: "delta", text: "stream-unsafe-" };
        yield { type: "delta", text: "output" };
        yield { type: "completed", result: successResult(unsafeAnswer) };
      },
    };
    const setup = createRuntime(orchestrator, {
      outputGuard: {
        evaluate: (input) =>
          Promise.resolve(
            input.text === unsafeAnswer
              ? {
                  action: "REDACT",
                  safe: true,
                  riskTypes: ["SECRET"],
                  sanitizedText: "[REDACTED]",
                }
              : { action: "ALLOW", safe: true, riskTypes: [] },
          ),
      },
    });

    const events = [];
    for await (const event of setup.runtime.stream({
      message: "safe query",
      user: { userId: "user-1" },
    })) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === "assistant.delta"),
    ).toEqual([{ type: "assistant.delta", text: "[REDACTED]" }]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      result: { answer: "[REDACTED]" },
    });
    expect(metric(setup.observability.measurements, "guard_redact_total"))
      .toEqual([
        expect.objectContaining({ attributes: { phase: "OUTPUT" }, value: 1 }),
      ]);
  });

  it("records fixed input redact and block decisions without content", async () => {
    let receivedQuery = "";
    const redactingGuard: GuardPort = {
      evaluate: () =>
        Promise.resolve({
          action: "REDACT",
          safe: true,
          riskTypes: ["SECRET"],
          sanitizedText: "[REDACTED]",
        }),
    };
    const redacted = createRuntime(
      executeOnly((input) => {
        receivedQuery = input.query;
        return Promise.resolve(successResult());
      }),
      { inputGuard: redactingGuard },
    );

    await redacted.runtime.chat({
      message: "input-secret",
      user: { userId: "user-1" },
    });

    expect(receivedQuery).toBe("[REDACTED]");
    expect(redacted.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "INPUT_REDACTED",
      "TURN_COMPLETED",
    ]);
    expect(metric(redacted.observability.measurements, "guard_redact_total"))
      .toEqual([
        expect.objectContaining({ attributes: { phase: "INPUT" }, value: 1 }),
      ]);
    expect(JSON.stringify(redacted.observability)).not.toContain("input-secret");

    const blocked = createRuntime(executeOnly(() => Promise.resolve(successResult())), {
      inputGuard: {
        evaluate: () =>
          Promise.resolve({ action: "BLOCK", safe: false, riskTypes: ["POLICY"] }),
      },
    });
    await expect(
      blocked.runtime.chat({ message: "blocked-secret", user: { userId: "user-1" } }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.INPUT_BLOCKED });
    expect(blocked.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "INPUT_BLOCKED",
      "TURN_FAILED",
    ]);
    expect(metric(blocked.observability.measurements, "guard_block_total"))
      .toEqual([
        expect.objectContaining({ attributes: { phase: "INPUT" }, value: 1 }),
      ]);
  });

  it("records output redact and block decisions exactly once", async () => {
    const outputGuard = (action: "BLOCK" | "REDACT"): GuardPort => ({
      evaluate: (input) =>
        Promise.resolve(
          input.text === "unsafe-output"
            ? action === "REDACT"
              ? {
                  action: "REDACT",
                  safe: true,
                  riskTypes: ["SECRET"],
                  sanitizedText: "[REDACTED]",
                }
              : { action: "BLOCK", safe: false, riskTypes: ["SECRET"] }
            : { action: "ALLOW", safe: true, riskTypes: [] },
        ),
    });
    const redacted = createRuntime(
      executeOnly(() => Promise.resolve(successResult("unsafe-output"))),
      { outputGuard: outputGuard("REDACT") },
    );

    const response = await redacted.runtime.chat({
      message: "safe query",
      user: { userId: "user-1" },
    });
    expect(response.answer).toBe("[REDACTED]");
    expect(metric(redacted.observability.measurements, "guard_redact_total"))
      .toEqual([
        expect.objectContaining({ attributes: { phase: "OUTPUT" }, value: 1 }),
      ]);

    const blocked = createRuntime(
      executeOnly(() => Promise.resolve(successResult("unsafe-output"))),
      { outputGuard: outputGuard("BLOCK") },
    );
    await expect(
      blocked.runtime.chat({ message: "safe query", user: { userId: "user-1" } }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.OUTPUT_BLOCKED });
    expect(blocked.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "OUTPUT_BLOCKED",
      "TURN_FAILED",
    ]);
    expect(metric(blocked.observability.measurements, "guard_block_total"))
      .toEqual([
        expect.objectContaining({ attributes: { phase: "OUTPUT" }, value: 1 }),
      ]);
    expect(JSON.stringify(blocked.observability)).not.toContain("unsafe-output");
  });

  it("records fail-safe and structured guard failures as canonical blocks", async () => {
    const inputFailure = createRuntime(
      executeOnly(() => Promise.resolve(successResult())),
      {
        inputGuard: {
          evaluate: () => Promise.reject(new Error("input guard secret")),
        },
      },
    );
    await expect(
      inputFailure.runtime.chat({ message: "safe", user: { userId: "user-1" } }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.INPUT_BLOCKED });
    expect(inputFailure.observability.auditEvents.map((event) => event.name))
      .toEqual(["TURN_STARTED", "INPUT_BLOCKED", "TURN_FAILED"]);

    const outputFailure = createRuntime(
      executeOnly(() => Promise.resolve(successResult())),
      {
        outputGuard: {
          evaluate: (input) =>
            input.text === "[]"
              ? Promise.resolve({
                  action: "REDACT",
                  safe: true,
                  riskTypes: ["STRUCTURED_SECRET"],
                  sanitizedText: "{}",
                })
              : Promise.resolve({ action: "ALLOW", safe: true, riskTypes: [] }),
        },
      },
    );
    await expect(
      outputFailure.runtime.chat({
        message: "safe",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.OUTPUT_BLOCKED });
    expect(outputFailure.observability.auditEvents.map((event) => event.name))
      .toEqual(["TURN_STARTED", "OUTPUT_BLOCKED", "TURN_FAILED"]);
    expect(metric(outputFailure.observability.measurements, "guard_block_total"))
      .toHaveLength(1);
    expect(metric(outputFailure.observability.measurements, "guard_redact_total"))
      .toHaveLength(0);
    expect(JSON.stringify(outputFailure.observability)).not.toMatch(
      /STRUCTURED_SECRET|input guard secret/u,
    );
  });

  it("counts safe provider failures and context conflicts without causes", async () => {
    const providerSecret = "provider-cause-secret";
    const failed = createRuntime(
      executeOnly(() => {
        failed.clock.advance(11);
        return Promise.reject(
          new RuntimeError(
            RuntimeErrorCode.PROVIDER_UNAVAILABLE,
            `unsafe ${providerSecret}`,
            { cause: { response: providerSecret } },
          ),
        );
      }),
    );
    await expect(
      failed.runtime.chat({ message: "safe", user: { userId: "user-1" } }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.PROVIDER_UNAVAILABLE });

    expect(metric(failed.observability.measurements, "provider_error_total"))
      .toHaveLength(1);
    expect(failed.observability.telemetryEvents[0]).toMatchObject({
      name: "TURN_FAILED",
      attributes: {
        errorCode: "PROVIDER_UNAVAILABLE",
        status: "FAILED",
      },
    });
    expect(JSON.stringify(failed.observability)).not.toContain(providerSecret);

    const baseStore = new InMemoryRuntimeStore();
    const conflictingStore: RuntimeStore = {
      ...baseStore,
      loadSessionAggregate: (sessionId) => baseStore.loadSessionAggregate(sessionId),
      restoreSession: (command) => baseStore.restoreSession(command),
      commitTurn: () =>
        Promise.reject(
          new RuntimeError(RuntimeErrorCode.SESSION_CONFLICT, "secret conflict"),
        ),
      recordFailedTurn: (command) => baseStore.recordFailedTurn(command),
      resetSession: (command) => baseStore.resetSession(command),
      commitCompaction: (command) => baseStore.commitCompaction(command),
      getSession: (sessionId) => baseStore.getSession(sessionId),
      getMessages: (sessionId) => baseStore.getMessages(sessionId),
    };
    const conflicted = createRuntime(
      executeOnly(() => Promise.resolve({
        ...successResult(),
        contextPatch: { conversation: { topic: "secret topic" } },
      })),
      { store: conflictingStore },
    );
    await expect(
      conflicted.runtime.chat({ message: "safe", user: { userId: "user-1" } }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.SESSION_CONFLICT });
    expect(metric(conflicted.observability.measurements, "context_conflict_total"))
      .toHaveLength(1);
    expect(conflicted.observability.auditEvents.map((event) => event.name))
      .not.toContain("CONTEXT_UPDATED");
    expect(conflicted.observability.auditEvents.map((event) => event.name))
      .not.toContain("TURN_COMPLETED");
  });

  it("records committed context updates and successful reset", async () => {
    const setup = createRuntime(
      executeOnly(() =>
        Promise.resolve({
          ...successResult(),
          contextPatch: { conversation: { topic: "safe-topic" } },
        }),
      ),
    );
    const first = await setup.runtime.chat({
      message: "first",
      user: { userId: "user-1" },
    });
    expect(setup.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "CONTEXT_UPDATED",
      "TURN_COMPLETED",
    ]);

    await setup.runtime.resetSession(first.sessionId);
    expect(setup.observability.auditEvents.at(-1)).toMatchObject({
      name: "SESSION_RESET",
      attributes: { sessionId: "session-1", status: "RESET" },
    });

  });

  it("counts an actual maintenance compaction before a failed business turn", async () => {
    let calls = 0;
    const setup = createRuntime(
      executeOnly(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(successResult())
          : Promise.reject(
              new RuntimeError(
                RuntimeErrorCode.ORCHESTRATION_FAILED,
                "business turn failed",
              ),
            );
      }),
      { threshold: 2 },
    );
    const first = await setup.runtime.chat({
      message: "first",
      user: { userId: "user-1" },
    });
    setup.observability.clear();

    await expect(
      setup.runtime.chat({
        sessionId: first.sessionId,
        message: "second",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.ORCHESTRATION_FAILED });

    expect(metric(setup.observability.measurements, "compaction_total"))
      .toHaveLength(1);
    expect(setup.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "TURN_FAILED",
    ]);
  });

  it("keeps a late abort after commit entry completed", async () => {
    const controller = new AbortController();
    const baseStore = new InMemoryRuntimeStore();
    const store: RuntimeStore = {
      loadSessionAggregate: (sessionId) => baseStore.loadSessionAggregate(sessionId),
      restoreSession: (command) => baseStore.restoreSession(command),
      commitTurn: async (command) => {
        controller.abort("late abort secret");
        return baseStore.commitTurn(command);
      },
      recordFailedTurn: (command) => baseStore.recordFailedTurn(command),
      resetSession: (command) => baseStore.resetSession(command),
      commitCompaction: (command) => baseStore.commitCompaction(command),
      getSession: (sessionId) => baseStore.getSession(sessionId),
      getMessages: (sessionId) => baseStore.getMessages(sessionId),
    };
    const setup = createRuntime(executeOnly(() => Promise.resolve(successResult())), {
      store,
    });

    await expect(
      setup.runtime.chat(
        { message: "safe", user: { userId: "user-1" } },
        controller.signal,
      ),
    ).resolves.toMatchObject({ status: "ANSWER" });
    expect(setup.observability.auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "TURN_COMPLETED",
    ]);
  });

  it("propagates a port contract violation without recursive observation", async () => {
    const portFailure = new Error("observability port contract violation");
    let calls = 0;
    const runtime = new ChatRuntime({
      orchestrator: executeOnly(() => Promise.resolve(successResult())),
      store: new InMemoryRuntimeStore(),
      config: DEFAULT_RUNTIME_CONFIG,
      provider: "mock",
      providerKey: "default",
      clock: new ManualClock(),
      idGenerator: new SequenceIdGenerator(),
      audit: {
        record: () => {
          calls += 1;
          throw portFailure;
        },
      },
    });

    await expect(
      runtime.chat({ message: "safe", user: { userId: "user-1" } }),
    ).rejects.toBe(portFailure);
    expect(calls).toBe(1);
  });

  it("unwraps a blocking TURN_FAILED port failure without recursive observation", async () => {
    const businessFailure = new RuntimeError(
      RuntimeErrorCode.ORCHESTRATION_FAILED,
      "business turn failed",
    );
    const portFailure = new Error("TURN_FAILED audit port failure");
    let failedAuditCalls = 0;
    const runtime = new ChatRuntime({
      orchestrator: executeOnly(() => Promise.reject(businessFailure)),
      store: new InMemoryRuntimeStore(),
      config: DEFAULT_RUNTIME_CONFIG,
      provider: "mock",
      providerKey: "default",
      clock: new ManualClock(),
      idGenerator: new SequenceIdGenerator(),
      audit: {
        record: (event) => {
          if (event.name === "TURN_FAILED") {
            failedAuditCalls += 1;
            throw portFailure;
          }
        },
      },
    });

    await expect(
      runtime.chat({ message: "safe", user: { userId: "user-1" } }),
    ).rejects.toBe(portFailure);
    expect(failedAuditCalls).toBe(1);
  });

  it("does not classify a later application reuse of a port Error as observability", async () => {
    const sharedError = new RuntimeError(
      RuntimeErrorCode.ORCHESTRATION_FAILED,
      "shared error instance",
    );
    const store = new InMemoryRuntimeStore();
    const auditNames: string[] = [];
    let firstAudit = true;
    const runtime = new ChatRuntime({
      orchestrator: executeOnly(() => Promise.reject(sharedError)),
      store,
      config: DEFAULT_RUNTIME_CONFIG,
      provider: "mock",
      providerKey: "default",
      clock: new ManualClock(),
      idGenerator: new SequenceIdGenerator(),
      audit: {
        record: (event) => {
          if (firstAudit) {
            firstAudit = false;
            throw sharedError;
          }
          auditNames.push(event.name);
        },
      },
    });

    await expect(
      runtime.chat({ message: "first", user: { userId: "user-1" } }),
    ).rejects.toBe(sharedError);
    await expect(
      runtime.chat({ message: "second", user: { userId: "user-1" } }),
    ).rejects.toBe(sharedError);

    expect(auditNames).toEqual(["TURN_STARTED", "TURN_FAILED"]);
    expect(store.getFailedTurns()).toHaveLength(1);
  });
});
