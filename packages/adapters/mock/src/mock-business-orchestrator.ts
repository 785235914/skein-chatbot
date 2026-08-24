import type { Source } from "@skein-chatbot/contracts";
import {
  createAbortedError,
  RuntimeError,
  RuntimeErrorCode,
  throwIfAborted,
  type BusinessOrchestrator,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
} from "@skein-chatbot/core";

export const MOCK_SCENARIOS = [
  "simple",
  "stream",
  "sources",
  "partial",
  "handoff",
  "timeout",
  "rate-limit",
  "unavailable",
  "invalid-result",
  "context-patch",
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export interface MockBusinessOrchestratorOptions {
  scenario?: MockScenario;
  /** Delay before the timeout scenario fails. */
  delayMs?: number;
  /** Optional delay between streamed answer chunks. */
  streamDelayMs?: number;
}

const scenarioSet: ReadonlySet<string> = new Set(MOCK_SCENARIOS);

export const isMockScenario = (value: unknown): value is MockScenario =>
  typeof value === "string" && scenarioSet.has(value);

const validateDelay = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      `${name} must be a finite, non-negative number.`,
    );
  }
  return value;
};

const waitAbortably = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      finish(() => {
        reject(createAbortedError(signal?.reason));
      });
    };
    const timer = setTimeout(() => {
      finish(resolve);
    }, milliseconds);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
    }
  });
};

const conversationIdFor = (input: OrchestrationInput): string =>
  input.providerConversationId ?? `mock-conversation-${input.sessionId}`;

const answerFor = (scenario: MockScenario, query: string): string => {
  switch (scenario) {
    case "stream":
      return `Mock streamed answer for: ${query}`;
    case "sources":
      return `Mock sourced answer for: ${query}`;
    case "partial":
      return `Mock partial answer for: ${query}`;
    case "handoff":
      return `Mock handoff response for: ${query}`;
    case "context-patch":
      return `Mock context update for: ${query}`;
    default:
      return `Mock answer for: ${query}`;
  }
};

const mockSources = (): Source[] => [
  {
    id: "mock-source-1",
    title: "Mock reference",
    url: "https://example.com/reference",
    provider: "mock",
    metadata: { rank: 1 },
  },
];

const createInvalidResult = (): OrchestrationResult =>
  ({
    answer: 42,
    status: "ANSWER",
    sources: "not-an-array",
  }) as unknown as OrchestrationResult;

const createResult = (
  scenario: MockScenario,
  input: OrchestrationInput,
): OrchestrationResult => {
  const common = {
    answer: answerFor(scenario, input.query),
    providerConversationId: conversationIdFor(input),
  };

  switch (scenario) {
    case "sources":
      return { ...common, status: "ANSWER", sources: mockSources() };
    case "partial":
      return {
        ...common,
        status: "PARTIAL",
        sources: [],
        followUpQuestion: "Would you like to continue?",
      };
    case "handoff":
      return {
        ...common,
        status: "HANDOFF",
        sources: [],
        followUpGuidance: "Continue with a human support channel.",
      };
    case "context-patch":
      return {
        ...common,
        status: "ANSWER",
        sources: [],
        contextPatch: {
          conversation: { topic: "mock-topic" },
          workflowState: { mockState: "updated" },
        },
      };
    case "invalid-result":
      return createInvalidResult();
    default:
      return { ...common, status: "ANSWER", sources: [] };
  }
};

/** Deterministic provider-free orchestrator used by runtime and API tests. */
export class MockBusinessOrchestrator implements BusinessOrchestrator {
  private readonly defaultScenario: MockScenario;
  private readonly delayMs: number;
  private readonly streamDelayMs: number;

  constructor(options: MockBusinessOrchestratorOptions = {}) {
    this.defaultScenario = options.scenario ?? "simple";
    this.delayMs = validateDelay("delayMs", options.delayMs ?? 60_000);
    this.streamDelayMs = validateDelay(
      "streamDelayMs",
      options.streamDelayMs ?? 0,
    );
  }

  async execute(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    throwIfAborted(signal);
    const scenario = this.scenarioFor(input);

    if (scenario === "timeout") {
      await waitAbortably(this.delayMs, signal);
      throw new RuntimeError(
        RuntimeErrorCode.PROVIDER_TIMEOUT,
        "The mock orchestrator timed out.",
        { retryable: true },
      );
    }
    if (scenario === "rate-limit") {
      throw new RuntimeError(
        RuntimeErrorCode.PROVIDER_RATE_LIMITED,
        "The mock orchestrator rate limit was reached.",
        { retryable: true },
      );
    }
    if (scenario === "unavailable") {
      throw new RuntimeError(
        RuntimeErrorCode.PROVIDER_UNAVAILABLE,
        "The mock orchestrator is unavailable.",
        { retryable: true },
      );
    }

    return createResult(scenario, input);
  }

  async *stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent> {
    throwIfAborted(signal);
    yield { type: "status", status: "Processing request" };

    const scenario = this.scenarioFor(input);
    const result = await this.execute(input, signal);
    throwIfAborted(signal);

    if (scenario === "stream") {
      for (const text of ["Mock streamed ", "answer for: ", input.query]) {
        await waitAbortably(this.streamDelayMs, signal);
        yield { type: "delta", text };
      }
    } else if (typeof result.answer === "string" && result.answer.length > 0) {
      yield { type: "delta", text: result.answer };
    }

    if (Array.isArray(result.sources)) {
      for (const source of result.sources) {
        throwIfAborted(signal);
        yield { type: "source", source };
      }
    }

    throwIfAborted(signal);
    yield { type: "completed", result };
  }

  private scenarioFor(input: OrchestrationInput): MockScenario {
    const override = input.metadata?.mockScenario;
    if (override === undefined) {
      return this.defaultScenario;
    }
    if (!isMockScenario(override)) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "metadata.mockScenario is not a supported mock scenario.",
      );
    }
    return override;
  }
}
