import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@skein-chatbot/contracts";
import {
  InMemoryRuntimeStore,
  ManualClock,
  SequenceIdGenerator,
} from "@skein-chatbot/test-utils";

import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  GuardPipeline,
  RuntimeError,
  RuntimeErrorCode,
  type BusinessOrchestrator,
  type CommitTurnCommand,
  type GuardPort,
  type GuardResult,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
  type RuntimeConfig,
} from "../src/index.js";

type StreamHandler = (
  input: OrchestrationInput,
  signal?: AbortSignal,
) => AsyncIterable<OrchestrationEvent>;

class RecordingOrchestrator implements BusinessOrchestrator {
  readonly inputs: OrchestrationInput[] = [];

  constructor(
    private readonly result: OrchestrationResult = {
      answer: "safe answer",
      status: "ANSWER",
      sources: [],
    },
    private readonly streamHandler?: StreamHandler,
  ) {}

  execute(input: OrchestrationInput): Promise<OrchestrationResult> {
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }

  async *stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent> {
    this.inputs.push(input);
    if (this.streamHandler !== undefined) {
      yield* this.streamHandler(input, signal);
      return;
    }
    yield { type: "completed", result: this.result };
  }
}

const result = (overrides: Partial<OrchestrationResult> = {}): OrchestrationResult => ({
  answer: "safe answer",
  status: "ANSWER",
  sources: [],
  ...overrides,
});

const config = (guards: { input: boolean; output: boolean }): RuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  guards,
});

const createRuntime = (
  orchestrator: BusinessOrchestrator,
  options: {
    config?: RuntimeConfig;
    inputGuard?: GuardPort;
    outputGuard?: GuardPort;
    store?: InMemoryRuntimeStore;
  } = {},
): { runtime: ChatRuntime; store: InMemoryRuntimeStore } => {
  const store = options.store ?? new InMemoryRuntimeStore();
  return {
    runtime: new ChatRuntime({
      orchestrator,
      store,
      config: options.config ?? config({ input: true, output: true }),
      provider: "provider",
      providerKey: "default",
      clock: new ManualClock(),
      idGenerator: new SequenceIdGenerator(),
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

const collect = async (events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> => {
  const values: RuntimeEvent[] = [];
  for await (const event of events) {
    values.push(event);
  }
  return values;
};

const guard = (evaluate: GuardPort["evaluate"]): GuardPort => ({ evaluate });

class DelayedCommitStore extends InMemoryRuntimeStore {
  constructor(
    private readonly commitStarted: () => void,
    private readonly waitForRelease: Promise<void>,
  ) {
    super();
  }

  override async commitTurn(command: CommitTurnCommand) {
    this.commitStarted();
    await this.waitForRelease;
    return super.commitTurn(command);
  }
}

describe("ChatRuntime guard integration", () => {
  it("normalizes all-ALLOW input to NFC and LF before session preparation", async () => {
    const observedTexts: string[] = [];
    const orchestrator = new RecordingOrchestrator();
    const { runtime } = createRuntime(orchestrator, {
      inputGuard: guard((input) => {
        observedTexts.push(input.text);
        return Promise.resolve({ action: "ALLOW", safe: true, riskTypes: [] });
      }),
    });

    await runtime.chat({
      sessionId: "allow-normalization",
      message: "Cafe\u0301\rline\r\nnext",
      user: { userId: "user-1" },
    });

    expect(observedTexts).toEqual(["Café\nline\nnext"]);
    expect(orchestrator.inputs[0]?.query).toBe("Café\nline\nnext");
  });

  it("uses default input redaction and normalization for the snapshot, provider, and stored user message", async () => {
    const orchestrator = new RecordingOrchestrator();
    const { runtime, store } = createRuntime(orchestrator);
    const request = {
      sessionId: "session-1",
      message: "Cafe\u0301\r\npassword=synthetic-secret",
      user: { userId: "user-1" },
    };

    await runtime.chat(request);

    expect(request.message).toBe("Cafe\u0301\r\npassword=synthetic-secret");
    expect(orchestrator.inputs[0]?.query).toBe("Café\n[REDACTED_CREDENTIAL]");
    expect((await runtime.getMessages("session-1"))[0]).toMatchObject({
      role: "USER",
      content: "Café\n[REDACTED_CREDENTIAL]",
    });
    expect(JSON.stringify(await store.loadSessionAggregate("session-1"))).not.toContain(
      "synthetic-secret",
    );
  });

  it.each(["BLOCK", "REVIEW"] as const)(
    "blocks %s input before session preparation for blocking and streaming turns",
    async (action) => {
      const orchestrator = new RecordingOrchestrator();
      const inputGuard = guard(() =>
        Promise.resolve({
          action,
          safe: false,
          riskTypes: ["POLICY"],
          reason: "not public",
        }),
      );
      const { runtime, store } = createRuntime(orchestrator, { inputGuard });

      await expect(
        runtime.chat({
          sessionId: "blocked-chat",
          message: "unsafe input",
          user: { userId: "user-1" },
        }),
      ).rejects.toMatchObject({
        code: RuntimeErrorCode.INPUT_BLOCKED,
        retryable: false,
      });
      const events = await collect(
        runtime.stream({
          sessionId: "blocked-stream",
          message: "unsafe input",
          user: { userId: "user-1" },
        }),
      );

      expect(events.at(-1)).toMatchObject({
        type: "turn.failed",
        error: { code: RuntimeErrorCode.INPUT_BLOCKED, retryable: false },
      });
      expect(orchestrator.inputs).toEqual([]);
      expect(await store.getSession("blocked-chat")).toBeNull();
      expect(await store.getSession("blocked-stream")).toBeNull();
      expect(await store.getMessages("blocked-chat")).toEqual([]);
      expect(await store.getMessages("blocked-stream")).toEqual([]);
      expect(store.getCompletedTurns("blocked-chat")).toEqual([]);
      expect(store.getCompletedTurns("blocked-stream")).toEqual([]);
    },
  );

  it("canonicalizes malformed injected guard results without echoing the guarded input", async () => {
    const secret = "synthetic-secret";
    const orchestrator = new RecordingOrchestrator();
    const { runtime } = createRuntime(orchestrator, {
      inputGuard: guard(() =>
        Promise.resolve({ action: "UNKNOWN" } as unknown as GuardResult),
      ),
    });

    let failure: unknown;
    try {
      await runtime.chat({
        sessionId: "session-1",
        message: `password=${secret}`,
        user: { userId: "user-1" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE });
    expect(String((failure as Error).message)).not.toContain(secret);
    expect(orchestrator.inputs).toEqual([]);
  });

  it("redacts default output credentials before response and assistant persistence", async () => {
    const { runtime } = createRuntime(
      new RecordingOrchestrator(result({ answer: "password=synthetic-secret" })),
    );

    const response = await runtime.chat({
      sessionId: "session-1",
      message: "safe input",
      user: { userId: "user-1" },
    });

    expect(response.answer).toBe("[REDACTED_CREDENTIAL]");
    expect((await runtime.getMessages("session-1"))[1]).toMatchObject({
      role: "ASSISTANT",
      content: "[REDACTED_CREDENTIAL]",
    });
  });

  it("redacts every optional follow-up surface before it reaches the response", async () => {
    const { runtime } = createRuntime(
      new RecordingOrchestrator(
        result({
          followUpQuestion: "password=synthetic-question",
          followUpGuidance: "password=synthetic-guidance",
        }),
      ),
    );

    await expect(
      runtime.chat({
        sessionId: "follow-up-redaction",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    ).resolves.toMatchObject({
      followUpQuestion: "[REDACTED_CREDENTIAL]",
      followUpGuidance: "[REDACTED_CREDENTIAL]",
    });
  });

  it("fails closed when a source metadata value contains a credential", async () => {
    const { runtime, store } = createRuntime(
      new RecordingOrchestrator(
        result({
          sources: [
            {
              title: "Reference",
              metadata: { note: "password=synthetic-source-metadata" },
            },
          ],
        }),
      ),
    );

    await expect(
      runtime.chat({
        sessionId: "source-metadata",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.OUTPUT_BLOCKED });
    expect(await store.getSession("source-metadata")).toBeNull();
  });

  it("reconstructs fixed input guard failures without a secret message or cause", async () => {
    const secret = "input-guard-secret";
    const injected = new RuntimeError(
      RuntimeErrorCode.PROVIDER_UNAVAILABLE,
      `guard error ${secret}`,
      { cause: { secret } },
    );
    const { runtime, store } = createRuntime(new RecordingOrchestrator(), {
      inputGuard: guard(() => Promise.reject(injected)),
    });

    let failure: unknown;
    try {
      await runtime.chat({
        sessionId: "input-guard-error",
        message: "safe input",
        user: { userId: "user-1" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: RuntimeErrorCode.INPUT_BLOCKED,
      message: "The request was blocked by a safety rule.",
      retryable: false,
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((failure as Error).message)).not.toContain(secret);
    expect(await store.getSession("input-guard-error")).toBeNull();
  });

  it("reconstructs malformed injected output results without preserving a guard cause", async () => {
    const secret = "malformed-output-secret";
    const { runtime } = createRuntime(new RecordingOrchestrator(), {
      outputGuard: guard(() =>
        Promise.resolve({ action: "UNKNOWN", secret } as unknown as GuardResult),
      ),
    });

    let failure: unknown;
    try {
      await runtime.chat({
        sessionId: "malformed-output",
        message: "safe input",
        user: { userId: "user-1" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      message: "The orchestrator returned an invalid response.",
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it("maps output guard size and thrown failures to a fixed output-blocked error", async () => {
    const secret = "output-guard-secret";
    const { runtime, store } = createRuntime(new RecordingOrchestrator(), {
      outputGuard: guard(() =>
        Promise.reject(
          new RuntimeError(
            RuntimeErrorCode.VALIDATION_ERROR,
            `guard failure ${secret}`,
            { cause: { secret } },
          ),
        ),
      ),
    });

    let failure: unknown;
    try {
      await runtime.chat({
        sessionId: "output-guard-error",
        message: "safe input",
        user: { userId: "user-1" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: RuntimeErrorCode.OUTPUT_BLOCKED,
      message: "The response was blocked by a safety rule.",
      retryable: false,
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((failure as Error).message)).not.toContain(secret);
    expect(await store.getSession("output-guard-error")).toBeNull();
  });

  it("maps an output guard size limit to output-blocked instead of validation-error", async () => {
    const { runtime, store } = createRuntime(
      new RecordingOrchestrator(result({ answer: "long output" })),
      {
        outputGuard: new GuardPipeline(
          [guard(() => Promise.resolve({ action: "ALLOW", safe: true, riskTypes: [] }))],
          { maxTextLength: 5 },
        ),
      },
    );

    await expect(
      runtime.chat({
        sessionId: "output-guard-size",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.OUTPUT_BLOCKED,
      message: "The response was blocked by a safety rule.",
    });
    expect(await store.getSession("output-guard-size")).toBeNull();
  });

  it("does not expose a secret-bearing output guard error through stream public events", async () => {
    const secret = "stream-output-guard-secret";
    const { runtime, store } = createRuntime(new RecordingOrchestrator(), {
      outputGuard: guard(() =>
        Promise.reject(
          new RuntimeError(
            RuntimeErrorCode.PROVIDER_UNAVAILABLE,
            `guard failure ${secret}`,
            { cause: { secret } },
          ),
        ),
      ),
    });

    const events = await collect(
      runtime.stream({
        sessionId: "stream-output-guard-error",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: {
        code: RuntimeErrorCode.OUTPUT_BLOCKED,
        message: "The response was blocked by a safety rule.",
      },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(await store.getSession("stream-output-guard-error")).toBeNull();
  });

  it.each([
    result({
      sources: [
        { title: "unsafe", url: "javascript:alert(1)" },
      ],
    }),
    result({ contextPatch: { workflowState: { leaked: "password=synthetic-secret" } } }),
  ])("fails closed on unsafe structured output with no partial commit", async (unsafeResult) => {
    const { runtime, store } = createRuntime(new RecordingOrchestrator(unsafeResult));

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.OUTPUT_BLOCKED, retryable: false });

    expect(await store.getSession("session-1")).toBeNull();
    expect(await store.getMessages("session-1")).toEqual([]);
    expect(store.getCompletedTurns("session-1")).toEqual([]);
  });

  it("buffers guarded deltas and exposes no content when a credential is split across them", async () => {
    const { runtime, store } = createRuntime(
      new RecordingOrchestrator(result(), async function* () {
        yield { type: "delta", text: "password=synthetic-" };
        yield { type: "source", source: { title: "Reference" } };
        yield { type: "delta", text: "secret" };
        yield { type: "completed", result: result() };
      }),
      {
        outputGuard: guard((input) =>
          Promise.resolve(
            input.text.includes("synthetic-secret")
              ? {
                  action: "BLOCK",
                  safe: false,
                  riskTypes: ["CREDENTIAL"],
                }
              : { action: "ALLOW", safe: true, riskTypes: [] },
          ),
        ),
      },
    );

    const events = await collect(
      runtime.stream({
        sessionId: "session-1",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    );

    expect(events).not.toContainEqual(expect.objectContaining({ type: "assistant.delta" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "source.added" }));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: RuntimeErrorCode.OUTPUT_BLOCKED },
    });
    expect(await store.getSession("session-1")).toBeNull();
  });

  it("collapses a redacted guarded stream to one sanitized delta", async () => {
    const { runtime } = createRuntime(
      new RecordingOrchestrator(result(), async function* () {
        yield { type: "delta", text: "secret " };
        yield { type: "delta", text: "delta" };
        yield { type: "completed", result: result() };
      }),
      {
        outputGuard: guard((input) =>
          Promise.resolve(
            input.text === "secret delta"
              ? {
                  action: "REDACT",
                  safe: true,
                  riskTypes: ["SENSITIVE"],
                  sanitizedText: "[SANITIZED_DELTA]",
                }
              : { action: "ALLOW", safe: true, riskTypes: [] },
          ),
        ),
      },
    );

    const events = await collect(
      runtime.stream({
        sessionId: "redacted-stream",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    );

    expect(events.filter((event) => event.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", text: "[SANITIZED_DELTA]" },
    ]);
  });

  it.each([
    {
      name: "buffered source",
      stream: async function* (): AsyncIterable<OrchestrationEvent> {
        yield { type: "source", source: { title: "unsafe-buffered-source" } };
        yield { type: "completed", result: result() };
      },
    },
    {
      name: "terminal result",
      stream: async function* (): AsyncIterable<OrchestrationEvent> {
        yield { type: "completed", result: result({ answer: "unsafe-terminal-result" }) };
      },
    },
  ])("blocks unsafe $name before releasing guarded stream content", async ({ stream }) => {
    const { runtime, store } = createRuntime(
      new RecordingOrchestrator(result(), stream),
      {
        outputGuard: guard((input) =>
          Promise.resolve(
            input.text.includes("unsafe-")
              ? { action: "BLOCK", safe: false, riskTypes: ["UNSAFE"] }
              : { action: "ALLOW", safe: true, riskTypes: [] },
          ),
        ),
      },
    );

    const events = await collect(
      runtime.stream({
        sessionId: "unsafe-stream",
        message: "safe input",
        user: { userId: "user-1" },
      }),
    );

    expect(events).not.toContainEqual(expect.objectContaining({ type: "assistant.delta" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "source.added" }));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: RuntimeErrorCode.OUTPUT_BLOCKED },
    });
    expect(await store.getSession("unsafe-stream")).toBeNull();
  });

  it("releases safe buffered stream content in provider order after state is committed", async () => {
    const { runtime, store } = createRuntime(
      new RecordingOrchestrator(result(), async function* () {
        yield { type: "status", status: "Preparing response" };
        yield { type: "delta", text: "safe " };
        yield { type: "source", source: { title: "Reference" } };
        yield { type: "delta", text: "answer" };
        yield { type: "completed", result: result() };
      }),
    );
    const events: RuntimeEvent[] = [];

    for await (const event of runtime.stream({
      sessionId: "session-1",
      message: "safe input",
      user: { userId: "user-1" },
    })) {
      events.push(event);
      if (event.type === "assistant.delta") {
        expect(await store.getSession("session-1")).not.toBeNull();
      }
    }

    expect(events).toEqual([
      { type: "turn.started" },
      { type: "status.changed", status: "Preparing response" },
      { type: "assistant.delta", text: "safe " },
      { type: "source.added", source: { title: "Reference" } },
      { type: "assistant.delta", text: "answer" },
      expect.objectContaining({ type: "turn.completed" }),
    ]);
  });

  it("keeps output-disabled streams real time before provider completion", async () => {
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = createRuntime(
      new RecordingOrchestrator(result(), async function* () {
        yield { type: "delta", text: "immediate" };
        await pending;
        yield { type: "completed", result: result() };
      }),
      { config: config({ input: true, output: false }) },
    );
    const iterator = runtime.stream({
      sessionId: "session-1",
      message: "safe input",
      user: { userId: "user-1" },
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn.started" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "assistant.delta", text: "immediate" },
    });
    release();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "turn.completed" },
    });
  });

  it("propagates abort through input guards and buffered guarded streams without public content or commit", async () => {
    let inputGuardStarted = (): void => undefined;
    const inputGuardPending = new Promise<void>((resolve) => {
      inputGuardStarted = resolve;
    });
    const inputController = new AbortController();
    const inputOrchestrator = new RecordingOrchestrator();
    const inputRuntime = createRuntime(inputOrchestrator, {
      inputGuard: guard((_input, signal) =>
        new Promise((_resolve, reject) => {
          inputGuardStarted();
          signal?.addEventListener(
            "abort",
            () => reject(new RuntimeError(RuntimeErrorCode.ABORTED, "aborted")),
            { once: true },
          );
        }),
      ),
    });
    const inputOperation = inputRuntime.runtime.chat(
      { sessionId: "input-abort", message: "safe", user: { userId: "user-1" } },
      inputController.signal,
    );
    await inputGuardPending;
    inputController.abort();
    await expect(inputOperation).rejects.toMatchObject({ code: RuntimeErrorCode.ABORTED });
    expect(inputOrchestrator.inputs).toEqual([]);
    expect(await inputRuntime.store.getSession("input-abort")).toBeNull();

    let deltaBuffered = (): void => undefined;
    const buffered = new Promise<void>((resolve) => {
      deltaBuffered = resolve;
    });
    const streamController = new AbortController();
    const streamRuntime = createRuntime(
      new RecordingOrchestrator(result(), async function* (_input, signal) {
        yield { type: "delta", text: "not public yet" };
        deltaBuffered();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }),
    );
    const streamOperation = collect(
      streamRuntime.runtime.stream(
        { sessionId: "stream-abort", message: "safe", user: { userId: "user-1" } },
        streamController.signal,
      ),
    );
    await buffered;
    streamController.abort();
    const events = await streamOperation;

    expect(events).not.toContainEqual(expect.objectContaining({ type: "assistant.delta" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "source.added" }));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: RuntimeErrorCode.ABORTED },
    });
    expect(await streamRuntime.store.getSession("stream-abort")).toBeNull();
  });

  it("aborts an in-progress output guard before commit without buffered content", async () => {
    let guardStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      guardStarted = resolve;
    });
    const controller = new AbortController();
    const { runtime, store } = createRuntime(new RecordingOrchestrator(), {
      outputGuard: guard((_input, signal) =>
        new Promise((_resolve, reject) => {
          guardStarted();
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new RuntimeError(
                  RuntimeErrorCode.ABORTED,
                  "output-guard-secret",
                  { cause: "output-guard-secret" },
                ),
              ),
            { once: true },
          );
        }),
      ),
    });
    const operation = runtime.chat(
      { sessionId: "output-guard-abort", message: "safe", user: { userId: "user-1" } },
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(operation).rejects.toMatchObject({
      code: RuntimeErrorCode.ABORTED,
      message: "The operation was aborted.",
    });
    expect(await store.getSession("output-guard-abort")).toBeNull();
  });

  it("treats delayed commit entry as irreversible when an abort arrives afterward", async () => {
    let started = (): void => undefined;
    const commitStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release = (): void => undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const store = new DelayedCommitStore(started, waitForRelease);
    const { runtime } = createRuntime(
      new RecordingOrchestrator(result(), async function* () {
        yield { type: "delta", text: "approved" };
        yield { type: "completed", result: result() };
      }),
      { store },
    );
    const operation = collect(
      runtime.stream(
        { sessionId: "late-abort", message: "safe", user: { userId: "user-1" } },
        controller.signal,
      ),
    );

    await commitStarted;
    controller.abort();
    release();
    const events = await operation;

    expect(events).toContainEqual({ type: "assistant.delta", text: "approved" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(await store.getSession("late-abort")).not.toBeNull();
  });

  it("validates guard flags and does not evaluate disabled injected guards", async () => {
    const orchestrator = new RecordingOrchestrator();
    expect(
      () =>
        createRuntime(orchestrator, {
          config: {
            ...DEFAULT_RUNTIME_CONFIG,
            guards: { input: "yes", output: true } as unknown as RuntimeConfig["guards"],
          },
        }),
    ).toThrow(expect.objectContaining({ code: RuntimeErrorCode.VALIDATION_ERROR }));
    expect(
      () =>
        createRuntime(orchestrator, {
          config: {
            ...DEFAULT_RUNTIME_CONFIG,
            guards: { input: true, output: "yes" } as unknown as RuntimeConfig["guards"],
          },
        }),
    ).toThrow(expect.objectContaining({ code: RuntimeErrorCode.VALIDATION_ERROR }));

    let guardCalls = 0;
    const { runtime } = createRuntime(orchestrator, {
      config: config({ input: false, output: false }),
      inputGuard: guard(() => {
        guardCalls += 1;
        return Promise.resolve({ action: "BLOCK", safe: false, riskTypes: [] });
      }),
      outputGuard: guard(() => {
        guardCalls += 1;
        return Promise.resolve({ action: "BLOCK", safe: false, riskTypes: [] });
      }),
    });

    await runtime.chat({
      sessionId: "session-1",
      message: "safe input",
      user: { userId: "user-1" },
    });
    expect(guardCalls).toBe(0);
  });

  it("applies input and output flags independently", async () => {
    let inputCalls = 0;
    let outputCalls = 0;
    const inputGuard = guard(() => {
      inputCalls += 1;
      return Promise.resolve({ action: "BLOCK", safe: false, riskTypes: [] });
    });
    const outputGuard = guard(() => {
      outputCalls += 1;
      return Promise.resolve({ action: "BLOCK", safe: false, riskTypes: [] });
    });
    const outputOnly = createRuntime(new RecordingOrchestrator(), {
      config: config({ input: false, output: true }),
      inputGuard,
      outputGuard,
    });

    await expect(
      outputOnly.runtime.chat({
        sessionId: "output-only",
        message: "safe",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.OUTPUT_BLOCKED });
    expect(inputCalls).toBe(0);
    expect(outputCalls).toBeGreaterThan(0);

    inputCalls = 0;
    outputCalls = 0;
    const inputOnly = createRuntime(new RecordingOrchestrator(), {
      config: config({ input: true, output: false }),
      inputGuard,
      outputGuard,
    });
    await expect(
      inputOnly.runtime.chat({
        sessionId: "input-only",
        message: "safe",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.INPUT_BLOCKED });
    expect(inputCalls).toBe(1);
    expect(outputCalls).toBe(0);
  });
});
