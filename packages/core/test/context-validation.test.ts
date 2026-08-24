import { describe, expect, it } from "vitest";

import {
  InMemoryRuntimeStore,
  ManualClock,
  SequenceIdGenerator,
} from "@skein-chatbot/test-utils";

import {
  ChatRuntime,
  DEFAULT_RUNTIME_CONFIG,
  RuntimeErrorCode,
  createContextValidator,
  normalizeContextPatch,
  validateSkeinContext,
  type BusinessOrchestrator,
  type CommitTurnCommand,
  type CommitTurnResult,
  type CompactionCommitCommand,
  type ContextExtensionProvider,
  type ContextValidationLimits,
  type FailedTurnCommand,
  type OrchestrationResult,
  type ResetSessionCommand,
  type RuntimeSession,
  type RuntimeStore,
  type SessionAggregate,
  type SkeinContext,
} from "../src/index.js";

const generousLimits: ContextValidationLimits = {
  maxSerializedBytes: 1_000_000,
  maxObjectDepth: 32,
  maxArrayLength: 1_000,
};

const contextWithState = (
  state: Record<string, unknown>,
  revision = 0,
): SkeinContext => ({
  version: "1.0",
  revision,
  conversation: {},
  workflow: { state },
  runtime: {},
});

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const resultWithPatch = (
  workflowState: Record<string, unknown>,
): OrchestrationResult => ({
  answer: "Done",
  status: "ANSWER",
  sources: [],
  contextPatch: { workflowState },
});

const orchestratorFor = (
  result: OrchestrationResult,
): BusinessOrchestrator => ({
  execute: () => Promise.resolve(result),
  stream: async function* () {
    yield { type: "completed", result };
  },
});

class AggregateFixtureStore implements RuntimeStore {
  readonly commits: CommitTurnCommand[] = [];
  readonly failures: FailedTurnCommand[] = [];

  constructor(private readonly aggregate: SessionAggregate) {}

  loadSessionAggregate(sessionId: string): Promise<SessionAggregate | null> {
    return Promise.resolve(
      sessionId === this.aggregate.session.id ? this.aggregate : null,
    );
  }

  commitTurn(command: CommitTurnCommand): Promise<CommitTurnResult> {
    this.commits.push(command);
    return Promise.reject(new Error("commitTurn must not be called"));
  }

  recordFailedTurn(command: FailedTurnCommand): Promise<void> {
    this.failures.push(command);
    return Promise.resolve();
  }

  resetSession(_command: ResetSessionCommand): Promise<void> {
    return Promise.resolve();
  }

  commitCompaction(_command: CompactionCommitCommand): Promise<void> {
    return Promise.resolve();
  }

  getSession(sessionId: string): Promise<RuntimeSession | null> {
    return Promise.resolve(
      sessionId === this.aggregate.session.id
        ? this.aggregate.session
        : null,
    );
  }

  getMessages(): Promise<readonly []> {
    return Promise.resolve([]);
  }
}

const fixtureAggregate = (
  context: SkeinContext,
  sessionRevision = context.revision,
): SessionAggregate => ({
  session: {
    id: "session-1",
    userId: "user-1",
    status: "ACTIVE",
    revision: sessionRevision,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  },
  context,
  messages: [],
  providerBindings: [],
});

const runtimeWith = (
  orchestrator: BusinessOrchestrator,
  options: {
    store?: RuntimeStore;
    extensionProvider?: ContextExtensionProvider;
    limits?: ContextValidationLimits;
  } = {},
): ChatRuntime =>
  new ChatRuntime({
    orchestrator,
    store: options.store ?? new InMemoryRuntimeStore(),
    config: DEFAULT_RUNTIME_CONFIG,
    provider: "provider",
    providerKey: "default",
    clock: new ManualClock(),
    idGenerator: new SequenceIdGenerator([
      "trace-1",
      "turn-1",
      "session-1",
      "message-1",
      "message-2",
    ]),
    ...(options.extensionProvider === undefined
      ? {}
      : { contextExtensionProvider: options.extensionProvider }),
    ...(options.limits === undefined
      ? {}
      : { contextValidationLimits: options.limits }),
  });

describe("Skein context structural limits", () => {
  it("accepts the exact serialized-byte boundary and rejects one byte less", () => {
    const context = contextWithState({ text: "四季" });
    const exactBytes = serializedBytes(context);
    const exact = createContextValidator({
      limits: { ...generousLimits, maxSerializedBytes: exactBytes },
    });
    const tooSmall = createContextValidator({
      limits: { ...generousLimits, maxSerializedBytes: exactBytes - 1 },
    });

    expect(exact.validateContext(context)).toEqual(context);
    expect(() => tooSmall.validateContext(context)).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("accepts the exact object-depth boundary and rejects one level more", () => {
    const validator = createContextValidator({
      limits: { ...generousLimits, maxObjectDepth: 3 },
    });

    expect(
      validator.validateContext(contextWithState({ nested: {} })),
    ).toMatchObject({ workflow: { state: { nested: {} } } });
    expect(() =>
      validator.validateContext(
        contextWithState({ nested: { tooDeep: {} } }),
      ),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("accepts the exact array-length boundary and rejects a longer array", () => {
    const validator = createContextValidator({
      limits: { ...generousLimits, maxArrayLength: 2 },
    });

    expect(
      validator.validateContext(contextWithState({ items: [1, 2] })),
    ).toMatchObject({ workflow: { state: { items: [1, 2] } } });
    expect(() =>
      validator.validateContext(contextWithState({ items: [1, 2, 3] })),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("applies array limits to provider patches with provider error semantics", () => {
    const validator = createContextValidator({
      limits: { ...generousLimits, maxArrayLength: 2 },
    });

    expect(
      normalizeContextPatch(
        { workflowState: { items: [1, 2] } },
        validator,
      ),
    ).toMatchObject({ workflowState: { items: [1, 2] } });
    expect(() =>
      normalizeContextPatch(
        { workflowState: { items: [1, 2, 3] } },
        validator,
      ),
    ).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
  });

  it("rejects invalid limit configuration before runtime execution", () => {
    expect(() =>
      createContextValidator({
        limits: { ...generousLimits, maxObjectDepth: -1 },
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.VALIDATION_ERROR }),
    );
  });
});

describe("Skein context JSON and reserved-key safety", () => {
  it.each([
    ["undefined", undefined],
    ["non-finite number", Number.NaN],
    ["bigint", BigInt(1)],
    ["function", (): void => undefined],
    ["symbol", Symbol("unsafe")],
    ["non-plain object", new Date("2026-01-01T00:00:00.000Z")],
  ])("rejects %s values", (_name, value) => {
    expect(() =>
      validateSkeinContext(contextWithState({ value }), {
        limits: generousLimits,
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("rejects cyclic values without recursing indefinitely", () => {
    const state: Record<string, unknown> = {};
    state.self = state;

    expect(() =>
      validateSkeinContext(contextWithState(state), {
        limits: generousLimits,
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("rejects sparse arrays and accessors without invoking getters", () => {
    const sparse = new Array<unknown>(2);
    sparse[0] = "present";
    let getterCalls = 0;
    const accessorState: Record<string, unknown> = {};
    Object.defineProperty(accessorState, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "should-not-run";
      },
    });

    expect(() =>
      validateSkeinContext(contextWithState({ sparse }), {
        limits: generousLimits,
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
    expect(() =>
      validateSkeinContext(contextWithState(accessorState), {
        limits: generousLimits,
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects nested prototype-pollution and runtime-owned provider keys", () => {
    const pollutionPatch = JSON.parse(
      '{"workflowState":{"safe":{"__proto__":{"polluted":true}}}}',
    ) as unknown;

    expect(() => normalizeContextPatch(pollutionPatch)).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
    expect(() =>
      normalizeContextPatch({
        workflowState: { stages: [{ nested: { updatedAt: "provider" } }] },
      }),
    ).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps conversation patches conservative and clones accepted state", () => {
    const workflowState = { phase: { name: "ready" } };
    const patch = normalizeContextPatch({
      conversation: { topic: "generic", language: "en" },
      workflowState,
    });
    workflowState.phase.name = "tampered";

    expect(patch).toEqual({
      conversation: { topic: "generic", language: "en" },
      workflowState: { phase: { name: "ready" } },
    });
    expect(() =>
      normalizeContextPatch({ conversation: { arbitrary: "not allowed" } }),
    ).toThrow(
      expect.objectContaining({
        code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
      }),
    );
  });
});

describe("Context extensions and safe commit integration", () => {
  it("accepts and sanitizes generic workflow state through an extension", async () => {
    const extensionProvider: ContextExtensionProvider = {
      validate(value) {
        const state = value as Record<string, unknown>;
        if (state.phase !== undefined && typeof state.phase !== "string") {
          throw new TypeError("phase must be a string");
        }
        return { ...state, extensionValidated: true };
      },
    };
    const store = new InMemoryRuntimeStore();
    const runtime = runtimeWith(
      orchestratorFor(resultWithPatch({ phase: "ready" })),
      { store, extensionProvider },
    );

    const response = await runtime.chat({
      message: "Update state",
      user: { userId: "user-1" },
    });
    const aggregate = await store.loadSessionAggregate(response.sessionId);

    expect(aggregate?.context).toEqual({
      version: "1.0",
      revision: 1,
      conversation: {},
      workflow: {
        state: { extensionValidated: true, phase: "ready" },
      },
      runtime: {
        lastTurnId: response.turnId,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(aggregate?.session.revision).toBe(aggregate?.context.revision);
  });

  it("commits nothing when the extension rejects merged provider state", async () => {
    const extensionProvider: ContextExtensionProvider = {
      validate(value) {
        const state = value as Record<string, unknown>;
        if (state.phase === "forbidden") {
          throw new TypeError("phase is not accepted");
        }
        return state;
      },
    };
    const store = new InMemoryRuntimeStore();
    const runtime = runtimeWith(
      orchestratorFor(resultWithPatch({ phase: "forbidden" })),
      { store, extensionProvider },
    );

    await expect(
      runtime.chat({
        message: "Reject state",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.CONTEXT_INVALID });
    expect(await store.getSession("session-1")).toBeNull();
    expect(await store.getMessages("session-1")).toEqual([]);
    expect(store.getFailedTurns("session-1")).toHaveLength(1);
  });

  it("rejects unsafe state returned by an extension", () => {
    const extensionProvider: ContextExtensionProvider = {
      validate() {
        return { nested: { revision: 7 } };
      },
    };

    expect(() =>
      validateSkeinContext(contextWithState({ acceptedInput: true }), {
        extensionProvider,
        limits: generousLimits,
      }),
    ).toThrow(
      expect.objectContaining({ code: RuntimeErrorCode.CONTEXT_INVALID }),
    );
  });

  it("validates loaded persisted context before orchestration or commit", async () => {
    const invalidContext = contextWithState({
      nested: { revision: 99 },
    });
    const store = new AggregateFixtureStore(fixtureAggregate(invalidContext));
    const result = resultWithPatch({ shouldNotRun: true });
    let executionCount = 0;
    const orchestrator: BusinessOrchestrator = {
      execute: () => {
        executionCount += 1;
        return Promise.resolve(result);
      },
      stream: async function* () {
        executionCount += 1;
        yield { type: "completed", result };
      },
    };
    const runtime = runtimeWith(orchestrator, { store });

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Load invalid state",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.CONTEXT_INVALID });
    expect(executionCount).toBe(0);
    expect(store.commits).toHaveLength(0);
    expect(store.failures).toHaveLength(1);
  });

  it("rejects a persisted session/context revision mismatch before commit", async () => {
    const store = new AggregateFixtureStore(
      fixtureAggregate(contextWithState({}, 1), 2),
    );
    const runtime = runtimeWith(
      orchestratorFor(resultWithPatch({ shouldNotRun: true })),
      { store },
    );

    await expect(
      runtime.chat({
        sessionId: "session-1",
        message: "Load mismatched revision",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.CONTEXT_INVALID });
    expect(store.commits).toHaveLength(0);
  });

  it("maps an invalid provider patch to provider response error atomically", async () => {
    const store = new InMemoryRuntimeStore();
    const runtime = runtimeWith(
      orchestratorFor(
        resultWithPatch({ nested: { runtime: { updatedAt: "provider" } } }),
      ),
      { store },
    );

    await expect(
      runtime.chat({
        message: "Attempt reserved write",
        user: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
    expect(await store.getSession("session-1")).toBeNull();
    expect(await store.getMessages("session-1")).toEqual([]);
  });
});
