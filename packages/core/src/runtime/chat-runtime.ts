import type {
  AbortSessionResponse,
  ChatResponse,
  MessageView,
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
import { RuntimeError, RuntimeErrorCode } from "../errors/runtime-error.js";
import { MemoryContextBuilder } from "../memory/memory.js";
import {
  DURABLE_PROVIDER_KEY_MAX_LENGTH,
  type BusinessOrchestrator,
} from "../orchestration/orchestration.js";
import type { Clock } from "../ports/clock.js";
import { NoopAuditPort, type AuditPort } from "../ports/audit.js";
import type { CompactionProvider } from "../ports/compaction.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { GuardPort } from "../ports/guard.js";
import type { RuntimeStore } from "../ports/runtime-store.js";
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
import {
  isObservabilityPortFailure,
  RuntimeObserver,
  unwrapObservabilityPortFailure,
} from "./runtime-observer.js";
import {
  TurnRunner,
  type RuntimeChatRequest,
} from "./turn-runner.js";

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
    typeof config.guards.output !== "boolean"
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The runtime configuration is invalid.",
    );
  }
};

export class ChatRuntime {
  private readonly activeTurns = new ActiveTurnRegistry();
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
}

export type { RuntimeChatRequest } from "./turn-runner.js";
