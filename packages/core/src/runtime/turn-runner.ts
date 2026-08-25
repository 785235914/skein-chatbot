import {
  JsonObjectSchema,
  type ChatMode,
  type ChatResponse,
  type ExecutionMode,
  type RuntimeEvent,
  type Source,
} from "@skein-chatbot/contracts";

import type { RuntimeConfig } from "../config/runtime-config.js";
import type { CompactionService } from "../compaction/compaction-service.js";
import type { SkeinContext } from "../context/context.js";
import type { ContextValidator } from "../context/context-validator.js";
import {
  RuntimeError,
  RuntimeErrorCode,
  throwIfAborted,
  toPublicError,
  toRuntimeError,
} from "../errors/runtime-error.js";
import {
  type MemoryContextBuilder,
  type RuntimeMemoryContext,
} from "../memory/memory.js";
import type {
  BusinessOrchestrator,
  OrchestrationInput,
  OrchestrationResult,
} from "../orchestration/orchestration.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { GuardPort, GuardResult } from "../ports/guard.js";
import type { ResumeTokenCodec } from "../ports/resume-token.js";
import type {
  FailedTurnCommand,
  ProviderConversationBinding,
  RuntimeStore,
  SessionAggregate,
} from "../ports/runtime-store.js";
import type { RuntimeUserContext } from "./user-context.js";
import {
  isObservabilityPortFailure,
  type RuntimeObserver,
  unwrapObservabilityPortFailure,
} from "./runtime-observer.js";
import { createTurnSnapshot, deepFreeze } from "../turn/turn-snapshot.js";
import { normalizeGuardText } from "../guard/text.js";

import type { ActiveTurnRegistry, ActiveTurnScope } from "./active-turn-registry.js";
import { createDefaultSkeinContext, mergeContextPatch } from "./context-merge.js";
import {
  createInvalidResponseError,
  normalizeOrchestrationResult,
  normalizeOrchestrationSource,
} from "./orchestration-result.js";

export interface RuntimeChatRequest {
  sessionId?: string;
  message: string;
  mode?: ChatMode;
  metadata?: Record<string, unknown>;
  user: RuntimeUserContext;
}

export interface TurnRunnerDependencies {
  orchestrator: BusinessOrchestrator;
  store: RuntimeStore;
  config: RuntimeConfig;
  provider: string;
  providerKey: string;
  clock: Clock;
  idGenerator: IdGenerator;
  activeTurns: ActiveTurnRegistry;
  contextValidator: ContextValidator;
  memoryContextBuilder: MemoryContextBuilder;
  compactionService: CompactionService;
  inputGuard: GuardPort;
  outputGuard: GuardPort;
  observer: RuntimeObserver;
  resumeTokenCodec?: ResumeTokenCodec;
}

interface TurnIdentity {
  traceId: string;
  turnId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  mode: ExecutionMode;
  startedAt: string;
  startedAtMs: number;
}

interface PreparedTurn extends TurnIdentity {
  request: RuntimeChatRequest;
  context: SkeinContext;
  snapshot: ReturnType<typeof createTurnSnapshot>;
  providerConversationId?: string;
}

type BufferedContentEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "source.added"; source: Source };

const safeStatuses: ReadonlySet<string> = new Set([
  "Processing request",
  "Searching knowledge",
  "Researching additional sources",
  "Preparing response",
]);

const safeStatus = (value: string): string =>
  safeStatuses.has(value) ? value : "Processing request";

const executionMode = (
  mode: ChatMode | undefined,
  fallback: ExecutionMode,
): ExecutionMode => {
  if (mode === undefined) {
    return fallback;
  }
  if (mode === "quick") {
    return "QUICK";
  }
  if (mode === "deep") {
    return "DEEP";
  }
  throw new RuntimeError(
    RuntimeErrorCode.VALIDATION_ERROR,
    "The chat mode is invalid.",
  );
};

const elapsedMilliseconds = (startedAtMs: number, endedAtMs: number): number =>
  Math.max(0, endedAtMs - startedAtMs);

const stableJson = (value: unknown): string => {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map(canonicalize);
    }
    if (typeof candidate === "object" && candidate !== null) {
      const record = candidate as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
};

export class TurnRunner {
  constructor(private readonly dependencies: TurnRunnerDependencies) {}

  async run(
    request: RuntimeChatRequest,
    parentSignal?: AbortSignal,
  ): Promise<ChatResponse> {
    const identity = this.createIdentity(request);
    let scope: ActiveTurnScope | undefined;

    try {
      scope = this.dependencies.activeTurns.register(
        identity.sessionId,
        parentSignal,
      );
      this.dependencies.observer.turnStarted(identity);
      throwIfAborted(scope.signal);
      const guardedRequest = await this.guardInput(
        identity,
        request,
        scope.signal,
      );
      const prepared = await this.prepare(
        identity,
        guardedRequest,
        scope.signal,
      );
      const input = this.orchestrationInput(prepared);
      const providerStartedAtMs = this.dependencies.clock.now().getTime();
      let rawResult: unknown;
      try {
        rawResult = await this.dependencies.orchestrator.execute(
          input,
          scope.signal,
        );
      } catch (error) {
        this.dependencies.observer.providerLatency(
          identity,
          providerStartedAtMs,
          "FAILED",
        );
        throw error;
      }
      this.dependencies.observer.providerLatency(
        identity,
        providerStartedAtMs,
        "COMPLETED",
      );
      throwIfAborted(scope.signal);
      const result = normalizeOrchestrationResult(
        rawResult,
        this.dependencies.contextValidator,
      );
      const guardedResult = await this.guardOutputResult(
        prepared,
        result,
        scope.signal,
      );
      return await this.commit(prepared, guardedResult, scope.signal);
    } catch (error) {
      if (isObservabilityPortFailure(error)) {
        throw unwrapObservabilityPortFailure(error);
      }
      const runtimeError = toRuntimeError(error, scope?.signal ?? parentSignal);
      try {
        await this.recordFailure(identity, runtimeError);
      } catch (recordingError) {
        if (isObservabilityPortFailure(recordingError)) {
          throw unwrapObservabilityPortFailure(recordingError);
        }
        throw recordingError;
      }
      throw runtimeError;
    } finally {
      scope?.close();
    }
  }

  async *stream(
    request: RuntimeChatRequest,
    parentSignal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    const identity = this.createIdentity(request);
    let scope: ActiveTurnScope | undefined;
    let providerStartedAtMs: number | undefined;
    let providerMeasurementRecorded = false;
    yield { type: "turn.started" };

    try {
      scope = this.dependencies.activeTurns.register(
        identity.sessionId,
        parentSignal,
      );
      this.dependencies.observer.turnStarted(identity);
      throwIfAborted(scope.signal);
      const guardedRequest = await this.guardInput(
        identity,
        request,
        scope.signal,
      );
      const prepared = await this.prepare(
        identity,
        guardedRequest,
        scope.signal,
      );
      const input = this.orchestrationInput(prepared);
      const bufferedContent: BufferedContentEvent[] = [];
      let concatenatedDeltaText = "";
      providerStartedAtMs = this.dependencies.clock.now().getTime();

      for await (const rawEvent of this.dependencies.orchestrator.stream(
        input,
        scope.signal,
      )) {
        throwIfAborted(scope.signal);
        if (
          typeof rawEvent !== "object" ||
          rawEvent === null ||
          !("type" in rawEvent)
        ) {
          throw createInvalidResponseError();
        }

        switch (rawEvent.type) {
          case "status":
            if (typeof rawEvent.status !== "string") {
              throw createInvalidResponseError();
            }
            yield {
              type: "status.changed",
              status: safeStatus(rawEvent.status),
            };
            break;
          case "delta":
            if (typeof rawEvent.text !== "string") {
              throw createInvalidResponseError();
            }
            if (this.dependencies.config.guards.output) {
              concatenatedDeltaText += rawEvent.text;
              bufferedContent.push({
                type: "assistant.delta",
                text: rawEvent.text,
              });
            } else {
              yield { type: "assistant.delta", text: rawEvent.text };
            }
            break;
          case "source": {
            const source = normalizeOrchestrationSource(rawEvent.source);
            if (this.dependencies.config.guards.output) {
              bufferedContent.push({ type: "source.added", source });
            } else {
              yield {
                type: "source.added",
                source,
              };
            }
            break;
          }
          case "completed": {
            this.dependencies.observer.providerLatency(
              identity,
              providerStartedAtMs,
              "COMPLETED",
            );
            providerMeasurementRecorded = true;
            const result = normalizeOrchestrationResult(
              rawEvent.result,
              this.dependencies.contextValidator,
            );
            throwIfAborted(scope.signal);
            const guardedResult = await this.guardOutputResult(
              prepared,
              result,
              scope.signal,
            );
            const guardedDeltaText = this.dependencies.config.guards.output
              ? concatenatedDeltaText === result.answer
                ? guardedResult.answer
                : await this.guardOutputText(
                    prepared,
                    concatenatedDeltaText,
                    scope.signal,
                  )
              : concatenatedDeltaText;
            if (this.dependencies.config.guards.output) {
              for (const event of bufferedContent) {
                if (event.type === "source.added") {
                  await this.guardStructuredOutput(
                    prepared,
                    event.source,
                    scope.signal,
                  );
                }
              }
            }
            const response = await this.commit(
              prepared,
              guardedResult,
              scope.signal,
            );
            if (this.dependencies.config.guards.output) {
              let emittedSanitizedDelta = false;
              const deltaWasRedacted =
                guardedDeltaText !== concatenatedDeltaText;
              for (const event of bufferedContent) {
                if (event.type === "assistant.delta" && deltaWasRedacted) {
                  if (!emittedSanitizedDelta) {
                    yield { type: "assistant.delta", text: guardedDeltaText };
                    emittedSanitizedDelta = true;
                  }
                  continue;
                }
                yield event;
              }
            }
            yield { type: "turn.completed", result: response };
            return;
          }
          default:
            throw createInvalidResponseError();
        }
      }

      throw createInvalidResponseError();
    } catch (error) {
      if (isObservabilityPortFailure(error)) {
        throw unwrapObservabilityPortFailure(error);
      }
      if (
        providerStartedAtMs !== undefined &&
        !providerMeasurementRecorded
      ) {
        this.dependencies.observer.providerLatency(
          identity,
          providerStartedAtMs,
          "FAILED",
        );
      }
      let runtimeError = toRuntimeError(error, scope?.signal ?? parentSignal);
      try {
        await this.recordFailure(identity, runtimeError);
      } catch (recordingError) {
        if (isObservabilityPortFailure(recordingError)) {
          throw unwrapObservabilityPortFailure(recordingError);
        }
        runtimeError = toRuntimeError(recordingError);
      }
      yield {
        type: "turn.failed",
        error: toPublicError(runtimeError, identity.traceId),
      };
    } finally {
      scope?.close();
    }
  }

  private createIdentity(request: RuntimeChatRequest): TurnIdentity {
    if (
      typeof request.message !== "string" ||
      request.message.length === 0 ||
      typeof request.user?.userId !== "string" ||
      request.user.userId.length === 0 ||
      (request.sessionId !== undefined && request.sessionId.length === 0)
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The runtime chat request is invalid.",
      );
    }
    if (request.metadata !== undefined) {
      const parsed = JsonObjectSchema.safeParse(request.metadata);
      if (!parsed.success) {
        throw new RuntimeError(
          RuntimeErrorCode.VALIDATION_ERROR,
          "The request metadata is invalid.",
          { cause: parsed.error },
        );
      }
    }

    const started = this.dependencies.clock.now();
    return {
      traceId: this.dependencies.idGenerator.generate(),
      turnId: this.dependencies.idGenerator.generate(),
      sessionId:
        request.sessionId ?? this.dependencies.idGenerator.generate(),
      userMessageId: this.dependencies.idGenerator.generate(),
      assistantMessageId: this.dependencies.idGenerator.generate(),
      mode: executionMode(request.mode, this.dependencies.config.defaultMode),
      startedAt: started.toISOString(),
      startedAtMs: started.getTime(),
    };
  }

  private async guardInput(
    identity: TurnIdentity,
    request: RuntimeChatRequest,
    signal: AbortSignal,
  ): Promise<RuntimeChatRequest> {
    if (!this.dependencies.config.guards.input) {
      return request;
    }
    const normalizedMessage = normalizeGuardText(request.message);
    let result: GuardResult;
    try {
      result = await this.dependencies.inputGuard.evaluate(
        {
          phase: "INPUT",
          traceId: identity.traceId,
          sessionId: identity.sessionId,
          text: normalizedMessage,
        },
        signal,
      );
    } catch (error) {
      const failure = this.inputGuardFailure(error, signal);
      if (failure.code === RuntimeErrorCode.INPUT_BLOCKED) {
        this.dependencies.observer.inputBlocked(identity);
      }
      throw failure;
    }
    if (signal.aborted) {
      throw this.abortedGuardFailure();
    }
    if (result.action === "BLOCK" || result.action === "REVIEW") {
      this.dependencies.observer.inputBlocked(identity);
      throw new RuntimeError(
        RuntimeErrorCode.INPUT_BLOCKED,
        "The request was blocked by a safety rule.",
      );
    }
    if (result.action === "REDACT") {
      this.dependencies.observer.inputRedacted(identity);
    }
    return {
      ...request,
      message:
        result.action === "REDACT" ? result.sanitizedText! : normalizedMessage,
    };
  }

  private async guardOutputText(
    prepared: PreparedTurn,
    text: string,
    signal: AbortSignal,
    allowRedaction = true,
  ): Promise<string> {
    if (!this.dependencies.config.guards.output) {
      return text;
    }
    let result: GuardResult;
    try {
      result = await this.dependencies.outputGuard.evaluate(
        {
          phase: "OUTPUT",
          traceId: prepared.traceId,
          sessionId: prepared.sessionId,
          text,
        },
        signal,
      );
    } catch (error) {
      const failure = this.outputGuardFailure(error, signal);
      if (failure.code === RuntimeErrorCode.OUTPUT_BLOCKED) {
        this.dependencies.observer.outputBlocked(prepared);
      }
      throw failure;
    }
    if (signal.aborted) {
      throw this.abortedGuardFailure();
    }
    if (result.action === "ALLOW") {
      return text;
    }
    if (result.action === "REDACT" && typeof result.sanitizedText === "string") {
      if (!allowRedaction) {
        this.dependencies.observer.outputBlocked(prepared);
        throw new RuntimeError(
          RuntimeErrorCode.OUTPUT_BLOCKED,
          "The response was blocked by a safety rule.",
        );
      }
      this.dependencies.observer.outputRedacted(prepared);
      return result.sanitizedText;
    }
    this.dependencies.observer.outputBlocked(prepared);
    throw new RuntimeError(
      RuntimeErrorCode.OUTPUT_BLOCKED,
      "The response was blocked by a safety rule.",
    );
  }

  private abortedGuardFailure(): RuntimeError {
    return new RuntimeError(
      RuntimeErrorCode.ABORTED,
      "The operation was aborted.",
    );
  }

  private inputGuardFailure(error: unknown, signal: AbortSignal): RuntimeError {
    const runtimeError = toRuntimeError(error, signal);
    if (runtimeError.code === RuntimeErrorCode.ABORTED) {
      return this.abortedGuardFailure();
    }
    if (runtimeError.code === RuntimeErrorCode.PROVIDER_INVALID_RESPONSE) {
      return new RuntimeError(
        RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
        "The orchestrator returned an invalid response.",
      );
    }
    return new RuntimeError(
      RuntimeErrorCode.INPUT_BLOCKED,
      "The request was blocked by a safety rule.",
    );
  }

  private outputGuardFailure(error: unknown, signal: AbortSignal): RuntimeError {
    const runtimeError = toRuntimeError(error, signal);
    if (runtimeError.code === RuntimeErrorCode.ABORTED) {
      return this.abortedGuardFailure();
    }
    if (runtimeError.code === RuntimeErrorCode.PROVIDER_INVALID_RESPONSE) {
      return new RuntimeError(
        RuntimeErrorCode.PROVIDER_INVALID_RESPONSE,
        "The orchestrator returned an invalid response.",
      );
    }
    return new RuntimeError(
      RuntimeErrorCode.OUTPUT_BLOCKED,
      "The response was blocked by a safety rule.",
    );
  }

  private async guardStructuredOutput(
    prepared: PreparedTurn,
    value: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const serialized = stableJson(value);
    const guarded = await this.guardOutputText(
      prepared,
      serialized,
      signal,
      false,
    );
    if (guarded !== serialized) {
      throw new RuntimeError(
        RuntimeErrorCode.OUTPUT_BLOCKED,
        "The response was blocked by a safety rule.",
      );
    }
  }

  private async guardOutputResult(
    prepared: PreparedTurn,
    result: OrchestrationResult,
    signal: AbortSignal,
  ): Promise<OrchestrationResult> {
    const answer = await this.guardOutputText(prepared, result.answer, signal);
    const followUpQuestion =
      result.followUpQuestion === undefined
        ? undefined
        : await this.guardOutputText(
            prepared,
            result.followUpQuestion,
            signal,
          );
    const followUpGuidance =
      result.followUpGuidance === undefined
        ? undefined
        : await this.guardOutputText(
            prepared,
            result.followUpGuidance,
            signal,
          );
    await this.guardStructuredOutput(prepared, result.sources, signal);
    if (result.contextPatch !== undefined) {
      await this.guardStructuredOutput(prepared, result.contextPatch, signal);
    }
    return {
      ...result,
      answer,
      sources: structuredClone(result.sources),
      ...(followUpQuestion === undefined ? {} : { followUpQuestion }),
      ...(followUpGuidance === undefined ? {} : { followUpGuidance }),
    };
  }

  private async prepare(
    identity: TurnIdentity,
    request: RuntimeChatRequest,
    signal: AbortSignal,
  ): Promise<PreparedTurn> {
    let aggregate = await this.dependencies.store.loadSessionAggregate(
      identity.sessionId,
    );
    throwIfAborted(signal);
    let context: SkeinContext;
    if (aggregate === null) {
      context = this.dependencies.contextValidator.validateContext(
        createDefaultSkeinContext(),
      );
    } else {
      context = this.validateOwnedAggregate(aggregate, request.user.userId);
      const compaction = await this.dependencies.compactionService.compact(
        { sessionId: identity.sessionId },
        signal,
      );
      throwIfAborted(signal);
      if (compaction.status === "COMPACTED") {
        this.dependencies.observer.compacted(identity);
        aggregate = await this.dependencies.store.loadSessionAggregate(
          identity.sessionId,
        );
        throwIfAborted(signal);
        if (aggregate === null) {
          throw new RuntimeError(
            RuntimeErrorCode.SESSION_CONFLICT,
            "The session changed during compaction.",
            { retryable: true },
          );
        }
        context = this.validateOwnedAggregate(
          aggregate,
          request.user.userId,
        );
      }
    }
    const memory = this.dependencies.memoryContextBuilder.build({
      messages: aggregate?.messages ?? [],
      ...(aggregate?.summary === undefined
        ? {}
        : { summary: aggregate.summary }),
    });
    const snapshot = createTurnSnapshot({
      traceId: identity.traceId,
      turnId: identity.turnId,
      sessionId: identity.sessionId,
      query: request.message,
      mode: identity.mode,
      context,
      memory,
      user: request.user,
      createdAt: identity.startedAt,
    });
    const binding = aggregate?.providerBindings.find(
      (candidate) =>
        candidate.provider === this.dependencies.provider &&
        candidate.providerKey === this.dependencies.providerKey,
    );

    return {
      ...identity,
      request,
      context,
      snapshot,
      ...(binding === undefined
        ? {}
        : { providerConversationId: binding.externalConversationId }),
    };
  }

  private validateOwnedAggregate(
    aggregate: SessionAggregate,
    userId: string,
  ): SkeinContext {
    if (aggregate.session.userId !== userId) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    const context = this.dependencies.contextValidator.validateContext(
      aggregate.context,
    );
    if (aggregate.session.revision !== context.revision) {
      throw new RuntimeError(
        RuntimeErrorCode.CONTEXT_INVALID,
        "The session and context revisions do not match.",
      );
    }
    return context;
  }

  private orchestrationInput(prepared: PreparedTurn): OrchestrationInput {
    const input: OrchestrationInput = {
      traceId: prepared.traceId,
      turnId: prepared.turnId,
      sessionId: prepared.sessionId,
      query: prepared.snapshot.query,
      mode: prepared.snapshot.mode,
      // The public port is frozen from M1; these runtime values are deeply
      // frozen even though that port's properties are structurally mutable.
      context: prepared.snapshot.context as unknown as SkeinContext,
      memory: prepared.snapshot.memory as unknown as RuntimeMemoryContext,
      user: prepared.snapshot.user as unknown as RuntimeUserContext,
      ...(prepared.providerConversationId === undefined
        ? {}
        : { providerConversationId: prepared.providerConversationId }),
      ...(prepared.request.metadata === undefined
        ? {}
        : { metadata: structuredClone(prepared.request.metadata) }),
    };
    return deepFreeze(input) as unknown as OrchestrationInput;
  }

  private async commit(
    prepared: PreparedTurn,
    result: OrchestrationResult,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const completed = this.dependencies.clock.now();
    const completedAt = completed.toISOString();
    const nextContext = mergeContextPatch(
      prepared.context,
      result.contextPatch,
      prepared.turnId,
      completedAt,
      this.dependencies.contextValidator,
    );
    let providerBinding: ProviderConversationBinding | undefined;
    if (result.providerConversationId !== undefined) {
      providerBinding = {
        sessionId: prepared.sessionId,
        provider: this.dependencies.provider,
        providerKey: this.dependencies.providerKey,
        externalConversationId: result.providerConversationId,
      };
    }
    let resumeToken: string | undefined;
    if (
      providerBinding !== undefined &&
      this.dependencies.resumeTokenCodec !== undefined
    ) {
      try {
        resumeToken = this.dependencies.resumeTokenCodec.encode({
          version: 1,
          sessionId: prepared.sessionId,
          userId: prepared.request.user.userId,
          provider: this.dependencies.provider,
          providerKey: this.dependencies.providerKey,
          externalConversationId: providerBinding.externalConversationId,
          issuedAt: completedAt,
        });
      } catch {
        throw new RuntimeError(
          RuntimeErrorCode.INTERNAL_ERROR,
          "The session resume token could not be created.",
        );
      }
    }
    const response: ChatResponse = {
      sessionId: prepared.sessionId,
      turnId: prepared.turnId,
      answer: result.answer,
      status: result.status,
      sources: structuredClone(result.sources),
      followUpQuestion: result.followUpQuestion ?? "",
      followUpGuidance: result.followUpGuidance ?? "",
      metadata: {},
      ...(resumeToken === undefined ? {} : { resumeToken }),
    };

    // commitTurn is the irreversible boundary: no abort check may run after it
    // begins because the store port intentionally has no rollback contract.
    throwIfAborted(signal);
    await this.dependencies.store.commitTurn({
      sessionId: prepared.sessionId,
      userId: prepared.request.user.userId,
      expectedRevision: prepared.context.revision,
      turn: {
        traceId: prepared.traceId,
        turnId: prepared.turnId,
        sessionId: prepared.sessionId,
        mode: prepared.mode,
        provider: this.dependencies.provider,
        providerKey: this.dependencies.providerKey,
        status: result.status,
        startedAt: prepared.startedAt,
        completedAt,
        latencyMs: elapsedMilliseconds(
          prepared.startedAtMs,
          completed.getTime(),
        ),
      },
      userMessage: {
        id: prepared.userMessageId,
        sessionId: prepared.sessionId,
        role: "USER",
        content: prepared.request.message,
        createdAt: prepared.startedAt,
      },
      assistantMessage: {
        id: prepared.assistantMessageId,
        sessionId: prepared.sessionId,
        role: "ASSISTANT",
        content: result.answer,
        createdAt: completedAt,
      },
      nextContext,
      ...(providerBinding === undefined ? {} : { providerBinding }),
    });

    this.dependencies.observer.turnCompleted(
      prepared,
      result.contextPatch !== undefined,
    );

    return response;
  }

  private async recordFailure(
    identity: TurnIdentity,
    error: RuntimeError,
  ): Promise<void> {
    const failed = this.dependencies.clock.now();
    this.dependencies.observer.turnFailed(identity, error.code);
    const command: FailedTurnCommand = {
      traceId: identity.traceId,
      turnId: identity.turnId,
      sessionId: identity.sessionId,
      mode: identity.mode,
      provider: this.dependencies.provider,
      providerKey: this.dependencies.providerKey,
      errorCode: error.code,
      startedAt: identity.startedAt,
      failedAt: failed.toISOString(),
      latencyMs: elapsedMilliseconds(identity.startedAtMs, failed.getTime()),
    };
    try {
      await this.dependencies.store.recordFailedTurn(command);
    } catch (recordingError) {
      throw new RuntimeError(
        RuntimeErrorCode.DATABASE_ERROR,
        "The failed turn could not be recorded.",
        { cause: { originalError: error, recordingError } },
      );
    }
  }

  observeSessionReset(sessionId: string): void {
    this.dependencies.observer.sessionReset(sessionId);
  }
}
