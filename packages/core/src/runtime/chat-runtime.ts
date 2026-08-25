import type {
  AbortSessionResponse,
  ChatResponse,
  MessageView,
  ResumeSessionResponse,
  ResetSessionResponse,
  RuntimeEvent,
  SessionView,
} from "@skein-chatbot/contracts";

import type { RuntimeConfig } from "../config/runtime-config.js";
import {
  CompactionService,
  DeterministicCompactionProvider,
} from "../compaction/index.js";
import type {
  ContextExtensionProvider,
  ContextValidationLimits,
} from "../context/context.js";
import { createContextValidator } from "../context/context-validator.js";
import {
  RuntimeError,
  RuntimeErrorCode,
  throwIfAborted,
} from "../errors/runtime-error.js";
import { MemoryContextBuilder } from "../memory/memory.js";
import {
  DURABLE_PROVIDER_KEY_MAX_LENGTH,
  type BusinessOrchestrator,
} from "../orchestration/orchestration.js";
import type { Clock } from "../ports/clock.js";
import { NoopAuditPort, type AuditPort } from "../ports/audit.js";
import type { CompactionProvider } from "../ports/compaction.js";
import type { ConversationHistorySource } from "../ports/conversation-history.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { GuardPort } from "../ports/guard.js";
import type { ResumeTokenCodec, SessionResumeClaims } from "../ports/resume-token.js";
import type {
  CanonicalMessage,
  ProviderConversationBinding,
  RuntimeStore,
  SessionAggregate,
} from "../ports/runtime-store.js";
import { NoopMetricsPort, type MetricsPort } from "../ports/metrics.js";
import {
  NoopTelemetryPort,
  type TelemetryPort,
} from "../ports/telemetry.js";
import {
  GuardPipeline,
  NoopContentSafetyPolicy,
  NoopEnterprisePolicy,
  NoopPiiDetector,
  PromptInjectionGuard,
  StaticOutputLeakGuard,
  StaticSecretGuard,
} from "../guard/index.js";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import { CryptoIdGenerator } from "./crypto-id-generator.js";
import { SystemClock } from "./system-clock.js";
import { createDefaultSkeinContext } from "./context-merge.js";
import {
  isObservabilityPortFailure,
  RuntimeObserver,
  unwrapObservabilityPortFailure,
} from "./runtime-observer.js";
import {
  TurnRunner,
  type RuntimeChatRequest,
} from "./turn-runner.js";
import type { RuntimeUserContext } from "./user-context.js";

export interface ChatRuntimeDependencies {
  orchestrator: BusinessOrchestrator;
  store: RuntimeStore;
  config: RuntimeConfig;
  provider: string;
  providerKey: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
  contextExtensionProvider?: ContextExtensionProvider;
  contextValidationLimits?: ContextValidationLimits;
  compactionProvider?: CompactionProvider;
  inputGuard?: GuardPort;
  outputGuard?: GuardPort;
  telemetry?: TelemetryPort;
  audit?: AuditPort;
  metrics?: MetricsPort;
  resumeTokenCodec?: ResumeTokenCodec;
  conversationHistorySource?: ConversationHistorySource;
}

const assertConfiguration = (dependencies: ChatRuntimeDependencies): void => {
  const { config } = dependencies;
  if (
    dependencies.provider.length === 0 ||
    dependencies.providerKey.length === 0 ||
    dependencies.providerKey.length > DURABLE_PROVIDER_KEY_MAX_LENGTH ||
    !Number.isInteger(config.recentMessages) ||
    config.recentMessages < 0 ||
    !Number.isInteger(config.compactionMessageThreshold) ||
    config.compactionMessageThreshold < 1 ||
    !Number.isFinite(config.compactionTokenThreshold) ||
    config.compactionTokenThreshold < 1 ||
    !Number.isFinite(config.quickTimeoutMs) ||
    config.quickTimeoutMs < 1 ||
    !Number.isFinite(config.deepTimeoutMs) ||
    config.deepTimeoutMs < 1 ||
    !Number.isInteger(config.retryAttempts) ||
    config.retryAttempts < 0 ||
    typeof config.guards !== "object" ||
    config.guards === null ||
    typeof config.guards.input !== "boolean" ||
    typeof config.guards.output !== "boolean" ||
    (dependencies.resumeTokenCodec === undefined) !==
      (dependencies.conversationHistorySource === undefined)
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The runtime configuration is invalid.",
    );
  }
};

export class ChatRuntime {
  private readonly activeTurns = new ActiveTurnRegistry();
  private readonly activeResumes = new Map<
    string,
    Promise<ResumeSessionResponse>
  >();
  private readonly clock: Clock;
  private readonly runner: TurnRunner;

  constructor(private readonly dependencies: ChatRuntimeDependencies) {
    assertConfiguration(dependencies);
    this.clock = dependencies.clock ?? new SystemClock();
    const contextValidator = createContextValidator({
      ...(dependencies.contextExtensionProvider === undefined
        ? {}
        : { extensionProvider: dependencies.contextExtensionProvider }),
      ...(dependencies.contextValidationLimits === undefined
        ? {}
        : { limits: dependencies.contextValidationLimits }),
    });
    const memoryContextBuilder = new MemoryContextBuilder({
      recentMessages: dependencies.config.recentMessages,
    });
    const compactionService = new CompactionService({
      store: dependencies.store,
      provider:
        dependencies.compactionProvider ??
        new DeterministicCompactionProvider(this.clock),
      clock: this.clock,
      config: dependencies.config,
    });
    const inputGuard =
      dependencies.inputGuard === undefined
        ? new GuardPipeline([
            new StaticSecretGuard(),
            new PromptInjectionGuard(),
            new NoopPiiDetector(),
            new NoopContentSafetyPolicy(),
            new NoopEnterprisePolicy(),
          ])
        : new GuardPipeline([dependencies.inputGuard]);
    const outputGuard =
      dependencies.outputGuard === undefined
        ? new GuardPipeline([
            new StaticSecretGuard(),
            new StaticOutputLeakGuard(),
            new NoopPiiDetector(),
            new NoopContentSafetyPolicy(),
            new NoopEnterprisePolicy(),
          ])
        : new GuardPipeline([dependencies.outputGuard]);
    const observer = new RuntimeObserver({
      telemetry: dependencies.telemetry ?? new NoopTelemetryPort(),
      audit: dependencies.audit ?? new NoopAuditPort(),
      metrics: dependencies.metrics ?? new NoopMetricsPort(),
      clock: this.clock,
      provider: dependencies.provider,
      providerKey: dependencies.providerKey,
    });
    this.runner = new TurnRunner({
      orchestrator: dependencies.orchestrator,
      store: dependencies.store,
      config: dependencies.config,
      provider: dependencies.provider,
      providerKey: dependencies.providerKey,
      clock: this.clock,
      idGenerator: dependencies.idGenerator ?? new CryptoIdGenerator(),
      activeTurns: this.activeTurns,
      contextValidator,
      memoryContextBuilder,
      compactionService,
      inputGuard,
      outputGuard,
      observer,
      ...(dependencies.resumeTokenCodec === undefined
        ? {}
        : { resumeTokenCodec: dependencies.resumeTokenCodec }),
    });
  }

  chat(
    request: RuntimeChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return this.runner.run(request, signal);
  }

  stream(
    request: RuntimeChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    return this.runner.stream(request, signal);
  }

  async resumeSession(
    resumeToken: string,
    user: RuntimeUserContext,
    signal?: AbortSignal,
  ): Promise<ResumeSessionResponse> {
    const codec = this.dependencies.resumeTokenCodec;
    const historySource = this.dependencies.conversationHistorySource;
    if (codec === undefined || historySource === undefined) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "Session resume is unavailable.",
      );
    }
    let claims: SessionResumeClaims;
    try {
      claims = codec.decode(resumeToken);
    } catch {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The session resume token is invalid.",
      );
    }
    if (
      claims.userId !== user.userId ||
      claims.provider !== this.dependencies.provider ||
      claims.providerKey !== this.dependencies.providerKey
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }

    const active = this.activeResumes.get(resumeToken);
    if (active !== undefined) {
      return active;
    }
    const operation = this.resumeDecodedSession(
      claims,
      codec,
      historySource,
      signal,
    );
    this.activeResumes.set(resumeToken, operation);
    try {
      return await operation;
    } finally {
      if (this.activeResumes.get(resumeToken) === operation) {
        this.activeResumes.delete(resumeToken);
      }
    }
  }

  async getSession(sessionId: string): Promise<SessionView> {
    const session = await this.dependencies.store.getSession(sessionId);
    if (session === null) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    return session;
  }

  async getMessages(sessionId: string): Promise<readonly MessageView[]> {
    if ((await this.dependencies.store.getSession(sessionId)) === null) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    return this.dependencies.store.getMessages(sessionId);
  }

  async resetSession(sessionId: string): Promise<ResetSessionResponse> {
    this.activeTurns.abort(sessionId);
    const session = await this.dependencies.store.getSession(sessionId);
    if (session === null) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    await this.dependencies.store.resetSession({
      sessionId,
      expectedRevision: session.revision,
      resetAt: this.clock.now().toISOString(),
    });
    const reset = await this.dependencies.store.getSession(sessionId);
    if (reset === null) {
      throw new RuntimeError(
        RuntimeErrorCode.DATABASE_ERROR,
        "The reset session could not be loaded.",
      );
    }
    try {
      this.runner.observeSessionReset(sessionId);
    } catch (error) {
      if (isObservabilityPortFailure(error)) {
        throw unwrapObservabilityPortFailure(error);
      }
      throw error;
    }
    return {
      sessionId,
      status: "RESET",
      revision: reset.revision,
    };
  }

  abortSession(sessionId: string): Promise<AbortSessionResponse> {
    return Promise.resolve({
      sessionId,
      aborted: this.activeTurns.abort(sessionId),
    });
  }

  private async resumeDecodedSession(
    claims: SessionResumeClaims,
    codec: ResumeTokenCodec,
    historySource: ConversationHistorySource,
    signal?: AbortSignal,
  ): Promise<ResumeSessionResponse> {
    throwIfAborted(signal);
    const existing = await this.dependencies.store.loadSessionAggregate(
      claims.sessionId,
    );
    if (existing !== null) {
      return this.responseForExistingResume(existing, claims, codec);
    }

    const history = await historySource.loadHistory(
      {
        externalConversationId: claims.externalConversationId,
        userId: claims.userId,
        maximumEntries: 200,
      },
      signal,
    );
    throwIfAborted(signal);
    const messages: CanonicalMessage[] = history.flatMap((entry) => [
      {
        id: `history:${entry.id}:user`,
        sessionId: claims.sessionId,
        role: "USER" as const,
        content: entry.userContent,
        createdAt: entry.createdAt,
      },
      {
        id: `history:${entry.id}:assistant`,
        sessionId: claims.sessionId,
        role: "ASSISTANT" as const,
        content: entry.assistantContent,
        createdAt: entry.createdAt,
      },
    ]);
    const firstTimestamp = history[0]?.createdAt ?? claims.issuedAt;
    const lastTimestamp = history.at(-1)?.createdAt ?? claims.issuedAt;
    const session = {
      id: claims.sessionId,
      userId: claims.userId,
      status: "ACTIVE" as const,
      revision: 0,
      createdAt: firstTimestamp,
      updatedAt: lastTimestamp,
      lastActiveAt: lastTimestamp,
    };
    const providerBinding: ProviderConversationBinding = {
      sessionId: claims.sessionId,
      provider: claims.provider,
      providerKey: claims.providerKey,
      externalConversationId: claims.externalConversationId,
    };
    const refreshedToken = this.encodeResumeToken(codec, claims);

    try {
      await this.dependencies.store.restoreSession({
        session,
        context: createDefaultSkeinContext(0),
        messages,
        providerBinding,
      });
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === RuntimeErrorCode.SESSION_CONFLICT
      ) {
        const raced = await this.dependencies.store.loadSessionAggregate(
          claims.sessionId,
        );
        if (raced !== null) {
          return this.responseForExistingResume(raced, claims, codec);
        }
      }
      throw error;
    }

    return {
      session: structuredClone(session),
      messages: structuredClone(messages),
      resumeToken: refreshedToken,
    };
  }

  private async responseForExistingResume(
    aggregate: SessionAggregate,
    claims: SessionResumeClaims,
    codec: ResumeTokenCodec,
  ): Promise<ResumeSessionResponse> {
    const binding = aggregate.providerBindings.find(
      (candidate) =>
        candidate.provider === claims.provider &&
        candidate.providerKey === claims.providerKey,
    );
    if (
      aggregate.session.userId !== claims.userId ||
      aggregate.session.status !== "ACTIVE" ||
      binding?.externalConversationId !== claims.externalConversationId
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.SESSION_NOT_FOUND,
        "The session was not found.",
      );
    }
    const messages = await this.dependencies.store.getMessages(
      claims.sessionId,
    );
    return {
      session: structuredClone(aggregate.session),
      messages: structuredClone([...messages]),
      resumeToken: this.encodeResumeToken(codec, claims),
    };
  }

  private encodeResumeToken(
    codec: ResumeTokenCodec,
    claims: SessionResumeClaims,
  ): string {
    try {
      return codec.encode({
        ...claims,
        issuedAt: this.clock.now().toISOString(),
      });
    } catch {
      throw new RuntimeError(
        RuntimeErrorCode.INTERNAL_ERROR,
        "The session resume token could not be created.",
      );
    }
  }
}

export type { RuntimeChatRequest } from "./turn-runner.js";
