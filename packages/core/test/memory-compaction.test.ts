import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_SUMMARY_LIMITS,
  ConversationSummaryValidationError,
  MemoryContextBuilder,
  REDACTED_CREDENTIAL,
  estimateConversationTokens,
  estimateTextTokens,
  normalizeConversationSummary,
  type ConversationSummary,
} from "../src/memory/memory.js";
import {
  CompactionService,
  DeterministicCompactionProvider,
  evaluateCompactionTrigger,
  selectCompactionCandidates,
  type CompactionConfiguration,
} from "../src/compaction/index.js";
import { RuntimeError, RuntimeErrorCode } from "../src/errors/runtime-error.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CompactionInput,
  CompactionProvider,
} from "../src/ports/compaction.js";
import type {
  CanonicalMessage,
  CommitTurnCommand,
  CommitTurnResult,
  CompactionCommitCommand,
  FailedTurnCommand,
  ResetSessionCommand,
  RuntimeSession,
  RuntimeStore,
  SessionAggregate,
} from "../src/ports/runtime-store.js";

const timestamp = (seconds = 0): string =>
  `2026-08-20T00:00:${String(seconds).padStart(2, "0")}.000Z`;

const message = (index: number, content = `message-${index}`): CanonicalMessage => ({
  id: `message-${index}`,
  sessionId: "session-1",
  role: index % 2 === 0 ? "ASSISTANT" : "USER",
  content,
  createdAt: timestamp(index),
});

const summary = (
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  topic: "General topic",
  userGoals: ["Understand the result"],
  confirmedFacts: ["The test is deterministic"],
  unresolvedIssues: [],
  entities: { component: "memory" },
  previousActions: ["Created a session"],
  summaryText: "Earlier semantic context.",
  createdAt: timestamp(),
  ...overrides,
});

const aggregate = (
  messages: readonly CanonicalMessage[],
  previousSummary?: ConversationSummary,
): SessionAggregate => ({
  session: {
    id: "session-1",
    userId: "user-1",
    status: "ACTIVE",
    revision: 7,
    createdAt: timestamp(),
    updatedAt: timestamp(1),
    lastActiveAt: timestamp(1),
  },
  context: {
    version: "1.0",
    revision: 7,
    conversation: { topic: "authoritative topic" },
    workflow: { state: { approval: "PENDING" } },
    runtime: {},
  },
  messages,
  providerBindings: [],
  ...(previousSummary === undefined ? {} : { summary: previousSummary }),
});

const fixedClock = (now = timestamp(20)): Clock => ({
  now: () => new Date(now),
  sleep: () => Promise.resolve(),
});

class RecordingStore implements RuntimeStore {
  readonly compactionCommits: CompactionCommitCommand[] = [];
  compactionError?: unknown;

  constructor(
    public value: SessionAggregate | null,
    private readonly exposeOnlyActiveMessages = false,
  ) {}

  loadSessionAggregate(_sessionId: string): Promise<SessionAggregate | null> {
    return Promise.resolve(this.value);
  }

  commitTurn(_command: CommitTurnCommand): Promise<CommitTurnResult> {
    return Promise.reject(new Error("commitTurn is outside this test"));
  }

  recordFailedTurn(_command: FailedTurnCommand): Promise<void> {
    return Promise.resolve();
  }

  resetSession(_command: ResetSessionCommand): Promise<void> {
    return Promise.resolve();
  }

  commitCompaction(command: CompactionCommitCommand): Promise<void> {
    if (this.compactionError !== undefined) {
      return Promise.reject(this.compactionError);
    }
    this.compactionCommits.push(command);
    if (this.exposeOnlyActiveMessages && this.value !== null) {
      const compacted = new Set(command.compactedMessageIds);
      this.value = {
        ...this.value,
        messages: this.value.messages.filter(
          (candidate) => !compacted.has(candidate.id),
        ),
        summary: command.summary,
      };
    }
    return Promise.resolve();
  }

  getSession(_sessionId: string): Promise<RuntimeSession | null> {
    return Promise.resolve(this.value?.session ?? null);
  }

  getMessages(_sessionId: string): Promise<readonly CanonicalMessage[]> {
    return Promise.resolve(this.value?.messages ?? []);
  }
}

const config = (
  overrides: Partial<CompactionConfiguration> = {},
): CompactionConfiguration => ({
  recentMessages: 2,
  compactionMessageThreshold: 5,
  compactionTokenThreshold: 100_000,
  ...overrides,
});

describe("conversation summary validation", () => {
  it("sanitizes credential-like material and deeply freezes the result", () => {
    const credentialValue = ["sample", "credential", "9371"].join("-");
    const connectionString = [
      "postgresql",
      "://",
      "sample-user:",
      credentialValue,
      "@db.invalid/example",
    ].join("");
    const normalized = normalizeConversationSummary(
      summary({
        topic: `authorization: Bearer ${credentialValue}`,
        userGoals: [`api_key=${credentialValue}`],
        entities: { login: connectionString },
        summaryText: `password=${credentialValue}`,
        createdAt: "2026-08-20T08:00:00+08:00",
      }),
    );
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain(credentialValue);
    expect(serialized).not.toContain("sample-user");
    expect(serialized).toContain("postgresql://");
    expect(serialized).toContain(REDACTED_CREDENTIAL);
    expect(normalized.createdAt).toBe(timestamp());
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.userGoals)).toBe(true);
    expect(Object.isFrozen(normalized.entities)).toBe(true);
  });

  it("removes a generic app credential token from deterministic summary content", () => {
    const token = ["app", "genericToken9472", "xYz8"].join("-");
    const normalized = normalizeConversationSummary(
      summary({ summaryText: `token=${token}` }),
    );

    expect(normalized.summaryText).not.toContain(token);
    expect(normalized.summaryText).toContain(REDACTED_CREDENTIAL);
  });

  it.each([
    ["unknown field", { ...summary(), extra: true }],
    [
      "too many list items",
      summary({
        userGoals: Array.from(
          { length: CONVERSATION_SUMMARY_LIMITS.listItems + 1 },
          (_, index) => String(index),
        ),
      }),
    ],
    [
      "oversized summary text",
      summary({
        summaryText: "x".repeat(
          CONVERSATION_SUMMARY_LIMITS.summaryTextCharacters + 1,
        ),
      }),
    ],
    [
      "oversized total structure",
      summary({
        userGoals: Array.from(
          { length: CONVERSATION_SUMMARY_LIMITS.listItems },
          () => "g".repeat(CONVERSATION_SUMMARY_LIMITS.listItemCharacters),
        ),
        confirmedFacts: Array.from(
          { length: CONVERSATION_SUMMARY_LIMITS.listItems },
          () => "f".repeat(CONVERSATION_SUMMARY_LIMITS.listItemCharacters),
        ),
      }),
    ],
    ["invalid timestamp", summary({ createdAt: "not-a-date" })],
    ["invalid entities", summary({ entities: [] as unknown as Record<string, string> })],
  ])("rejects a structurally invalid summary: %s", (_label, value) => {
    expect(() => normalizeConversationSummary(value)).toThrow(
      ConversationSummaryValidationError,
    );
  });
});

describe("MemoryContextBuilder", () => {
  it("selects the exact latest N messages in canonical order", () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(index + 1));
    const original = structuredClone(messages);
    const memory = new MemoryContextBuilder({ recentMessages: 3 }).build({
      messages,
      summary: summary({ confirmedFacts: ["Semantic only; not workflow state"] }),
    });

    expect(memory.recentMessages.map(({ id }) => id)).toEqual([
      "message-3",
      "message-4",
      "message-5",
    ]);
    expect(memory.recentMessages.map(({ content }) => content)).toEqual([
      "message-3",
      "message-4",
      "message-5",
    ]);
    expect(memory).not.toHaveProperty("context");
    expect(memory).not.toHaveProperty("workflow");
    expect(Object.isFrozen(memory)).toBe(true);
    expect(Object.isFrozen(memory.recentMessages)).toBe(true);
    expect(
      new MemoryContextBuilder({ recentMessages: 3 }).estimateTokens({
        messages,
        summary: summary(),
      }),
    ).toBeGreaterThan(0);
    expect(messages).toEqual(original);
  });

  it("handles a zero-sized window without the Array.slice negative-zero trap", () => {
    const memory = new MemoryContextBuilder({ recentMessages: 0 }).build({
      messages: [message(1), message(2)],
    });
    expect(memory).toEqual({ recentMessages: [] });
  });

  it("rejects invalid window configuration", () => {
    expect(() => new MemoryContextBuilder({ recentMessages: -1 })).toThrow(
      RangeError,
    );
    expect(() => new MemoryContextBuilder({ recentMessages: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("provider-neutral token estimation and compaction trigger", () => {
  it("uses a deterministic UTF-8 estimate", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("你好")).toBe(2);
    expect(estimateConversationTokens([message(1, "abcd")])).toBe(6);
  });

  it("triggers on count, estimated tokens, or a manual request", () => {
    const messages = [message(1, "a"), message(2, "b")];
    expect(evaluateCompactionTrigger(config({ compactionMessageThreshold: 2 }), { messages })).toMatchObject({
      shouldCompact: true,
      reasons: ["MESSAGE_COUNT"],
    });
    expect(
      evaluateCompactionTrigger(config({ compactionTokenThreshold: 1 }), {
        messages: [message(1, "a")],
      }),
    ).toMatchObject({ shouldCompact: true, reasons: ["ESTIMATED_TOKENS"] });
    expect(
      evaluateCompactionTrigger(config(), {
        messages: [message(1, "a")],
        manual: true,
      }),
    ).toMatchObject({ shouldCompact: true, reasons: ["MANUAL"] });
  });

  it("does not trigger below both automatic thresholds", () => {
    expect(
      evaluateCompactionTrigger(config(), { messages: [message(1, "a")] }),
    ).toMatchObject({ shouldCompact: false, reasons: [] });
  });
});

describe("CompactionService", () => {
  it("sends only older messages and commits a sanitized summary atomically", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(index + 1));
    const state = aggregate(messages, summary());
    const workflowBefore = structuredClone(state.context.workflow.state);
    const store = new RecordingStore(state);
    const controller = new AbortController();
    const credentialValue = ["provider", "credential", "8426"].join("-");
    const provider: CompactionProvider = {
      summarize: vi.fn((input: CompactionInput, receivedSignal?: AbortSignal) => {
        expect(receivedSignal).toBe(controller.signal);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.messages)).toBe(true);
        expect(input.messages.map(({ id }) => id)).toEqual([
          "message-1",
          "message-2",
          "message-3",
        ]);
        return Promise.resolve(
          summary({ summaryText: `api_key=${credentialValue}` }),
        );
      }),
    };
    const service = new CompactionService({
      store,
      provider,
      clock: fixedClock(),
      config: config(),
    });

    const result = await service.compact(
      { sessionId: "session-1" },
      controller.signal,
    );

    expect(result.status).toBe("COMPACTED");
    expect(JSON.stringify(result)).not.toContain(credentialValue);
    expect(store.compactionCommits).toHaveLength(1);
    expect(store.compactionCommits[0]).toMatchObject({
      sessionId: "session-1",
      expectedRevision: 7,
      compactedMessageIds: ["message-1", "message-2", "message-3"],
      committedAt: timestamp(20),
    });
    expect(store.compactionCommits[0]).not.toHaveProperty("context");
    expect(state.context.workflow.state).toEqual(workflowBefore);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("exposes exact candidate boundaries independently", () => {
    const messages = Array.from({ length: 5 }, (_, index) => message(index + 1));
    expect(selectCompactionCandidates(messages, 2).map(({ id }) => id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
    ]);
    expect(selectCompactionCandidates(messages, 5)).toEqual([]);
    expect(selectCompactionCandidates(messages, 0).map(({ id }) => id)).toEqual(
      messages.map(({ id }) => id),
    );
  });

  it("does not invoke the provider or store when no trigger fires", async () => {
    const store = new RecordingStore(aggregate([message(1), message(2)]));
    const provider: CompactionProvider = { summarize: vi.fn() };
    const service = new CompactionService({
      store,
      provider,
      clock: fixedClock(),
      config: config(),
    });

    await expect(service.compact({ sessionId: "session-1" })).resolves.toMatchObject({
      status: "SKIPPED",
      reason: "THRESHOLD_NOT_MET",
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(store.compactionCommits).toHaveLength(0);
  });

  it("honors manual trigger but never compacts the protected recent window", async () => {
    const store = new RecordingStore(aggregate([message(1), message(2)]));
    const provider: CompactionProvider = { summarize: vi.fn() };
    const service = new CompactionService({
      store,
      provider,
      clock: fixedClock(),
      config: config({ recentMessages: 2 }),
    });

    await expect(
      service.compact({ sessionId: "session-1", manual: true }),
    ).resolves.toMatchObject({
      status: "SKIPPED",
      reason: "NO_ELIGIBLE_MESSAGES",
      decision: { reasons: ["MANUAL"] },
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(store.compactionCommits).toHaveLength(0);
  });

  it("manually compacts eligible history below automatic thresholds", async () => {
    const store = new RecordingStore(
      aggregate([message(1), message(2), message(3)]),
    );
    const provider: CompactionProvider = {
      summarize: vi.fn(() => Promise.resolve(summary())),
    };
    const service = new CompactionService({
      store,
      provider,
      clock: fixedClock(),
      config: config(),
    });

    await expect(
      service.compact({ sessionId: "session-1", manual: true }),
    ).resolves.toMatchObject({
      status: "COMPACTED",
      decision: { reasons: ["MANUAL"] },
      compactedMessageIds: ["message-1"],
    });
    expect(provider.summarize).toHaveBeenCalledOnce();
    expect(store.compactionCommits).toHaveLength(1);
  });

  it("does not compact IDs twice when the store exposes active memory messages", async () => {
    const initialMessages = Array.from({ length: 5 }, (_, index) =>
      message(index + 1),
    );
    const store = new RecordingStore(aggregate(initialMessages), true);
    const service = new CompactionService({
      store,
      provider: new DeterministicCompactionProvider(fixedClock()),
      clock: fixedClock(),
      config: config(),
    });

    await expect(service.compact({ sessionId: "session-1" })).resolves.toMatchObject({
      status: "COMPACTED",
      compactedMessageIds: ["message-1", "message-2", "message-3"],
    });
    await expect(service.compact({ sessionId: "session-1" })).resolves.toMatchObject({
      status: "SKIPPED",
      reason: "THRESHOLD_NOT_MET",
    });

    const active = store.value;
    expect(active).not.toBeNull();
    store.value = {
      ...active!,
      messages: [
        ...active!.messages,
        message(6),
        message(7),
        message(8),
      ],
    };
    await expect(service.compact({ sessionId: "session-1" })).resolves.toMatchObject({
      status: "COMPACTED",
      compactedMessageIds: ["message-4", "message-5", "message-6"],
    });
    expect(store.compactionCommits.flatMap((commit) => commit.compactedMessageIds)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
    ]);
  });

  it("does not commit when the provider fails or returns an invalid summary", async () => {
    const providerFailure = new Error("summary provider unavailable");
    const failingStore = new RecordingStore(
      aggregate([message(1), message(2), message(3)]),
    );
    const failing = new CompactionService({
      store: failingStore,
      provider: { summarize: () => Promise.reject(providerFailure) },
      clock: fixedClock(),
      config: config({ compactionMessageThreshold: 3 }),
    });
    await expect(failing.compact({ sessionId: "session-1" })).rejects.toBe(
      providerFailure,
    );
    expect(failingStore.compactionCommits).toHaveLength(0);

    const invalidStore = new RecordingStore(
      aggregate([message(1), message(2), message(3)]),
    );
    const invalid = new CompactionService({
      store: invalidStore,
      provider: {
        summarize: () => Promise.resolve({ summaryText: "missing fields" } as ConversationSummary),
      },
      clock: fixedClock(),
      config: config({ compactionMessageThreshold: 3 }),
    });
    await expect(invalid.compact({ sessionId: "session-1" })).rejects.toMatchObject({
      code: RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
    });
    expect(invalidStore.compactionCommits).toHaveLength(0);
  });

  it("propagates revision conflicts without rewriting them", async () => {
    const store = new RecordingStore(
      aggregate([message(1), message(2), message(3)]),
    );
    const conflict = new RuntimeError(
      RuntimeErrorCode.SESSION_CONFLICT,
      "revision conflict",
    );
    store.compactionError = conflict;
    const service = new CompactionService({
      store,
      provider: { summarize: () => Promise.resolve(summary()) },
      clock: fixedClock(),
      config: config({ compactionMessageThreshold: 3 }),
    });

    await expect(service.compact({ sessionId: "session-1" })).rejects.toBe(
      conflict,
    );
    expect(store.compactionCommits).toHaveLength(0);
  });

  it("passes AbortSignal through and prevents a post-provider commit", async () => {
    const controller = new AbortController();
    const store = new RecordingStore(
      aggregate([message(1), message(2), message(3)]),
    );
    const service = new CompactionService({
      store,
      provider: {
        summarize: (_input, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort("stop after provider");
          return Promise.resolve(summary());
        },
      },
      clock: fixedClock(),
      config: config({ compactionMessageThreshold: 3 }),
    });

    await expect(
      service.compact({ sessionId: "session-1" }, controller.signal),
    ).rejects.toMatchObject({ code: RuntimeErrorCode.ABORTED });
    expect(store.compactionCommits).toHaveLength(0);
  });
});

describe("DeterministicCompactionProvider", () => {
  it("is deterministic, preserves only semantic history, and removes secrets", async () => {
    const provider = new DeterministicCompactionProvider(fixedClock());
    const credentialValue = ["local", "credential", "580274"].join("-");
    const input: CompactionInput = {
      sessionId: "session-1",
      messages: [
        message(1, `Please remember api_key=${credentialValue}`),
        message(2, `Authorization: Bearer ${credentialValue}`),
      ],
      previousSummary: summary({
        userGoals: ["Keep semantic continuity"],
        summaryText: `Earlier password=${credentialValue}`,
      }),
    };

    const first = await provider.summarize(input);
    const second = await provider.summarize(input);
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.userGoals).toEqual(["Keep semantic continuity"]);
    expect(first.confirmedFacts).toEqual(["The test is deterministic"]);
    expect(first.summaryText).toContain("[Earlier messages]");
    expect(serialized).not.toContain(credentialValue);
    expect(serialized).toContain(REDACTED_CREDENTIAL);
    expect(serialized).not.toContain("workflow");
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("bounds large transcripts to the summary structural limit", async () => {
    const provider = new DeterministicCompactionProvider(fixedClock());
    const result = await provider.summarize({
      sessionId: "session-1",
      messages: Array.from({ length: 20 }, (_, index) =>
        message(index + 1, "x".repeat(2_000)),
      ),
    });
    expect(result.summaryText.length).toBeLessThanOrEqual(
      CONVERSATION_SUMMARY_LIMITS.summaryTextCharacters,
    );
    expect(() => normalizeConversationSummary(result)).not.toThrow();
  });

  it("fits transcript text around a large but valid previous structure", async () => {
    const provider = new DeterministicCompactionProvider(fixedClock());
    const previousSummary: ConversationSummary = {
      userGoals: Array.from({ length: 32 }, () => "g".repeat(1_000)),
      confirmedFacts: [],
      unresolvedIssues: [],
      entities: {},
      previousActions: [],
      summaryText: "",
      createdAt: timestamp(),
    };
    const result = await provider.summarize({
      sessionId: "session-1",
      messages: [message(1, "x".repeat(2_000))],
      previousSummary,
    });

    expect(result.summaryText.length).toBeLessThanOrEqual(768);
    expect(() => normalizeConversationSummary(result)).not.toThrow();
  });
});
