import {
  createDifyBusinessOrchestrator,
  createDifyConversationHistorySource,
  loadDifyProfile,
} from "@skein-chatbot/adapter-dify";
import { MockBusinessOrchestrator } from "@skein-chatbot/adapter-mock";
import {
  ChatRuntime,
  DURABLE_PROVIDER_KEY_MAX_LENGTH,
  RuntimeError,
  RuntimeErrorCode,
  createReliableBusinessOrchestrator,
  type BusinessOrchestrator,
  type AuditPort,
  type ConversationHistorySource,
  type MetricsPort,
  type ResumeTokenCodec,
  type RuntimeStore,
  type TelemetryPort,
} from "@skein-chatbot/core";
import { InMemoryRuntimeStore } from "@skein-chatbot/test-utils";

import type { ApiRuntime } from "./api-runtime.js";
import type { ApiConfig } from "./config.js";
import { createEncryptedResumeTokenCodec } from "./session-resume-token.js";

interface OrchestratorComposition {
  conversationHistorySource?: ConversationHistorySource;
  orchestrator: BusinessOrchestrator;
  provider: "dify" | "mock";
  providerKey: string;
  resumeTokenCodec?: ResumeTokenCodec;
}

export interface PostgresRuntimeStoreHandle {
  store: RuntimeStore;
  disconnect(): Promise<void>;
}

export type PostgresRuntimeStoreFactory = (options: {
  databaseUrl: string;
}) => Promise<PostgresRuntimeStoreHandle>;

export interface ApiRuntimeCompositionDependencies {
  createPostgresRuntimeStore?: PostgresRuntimeStoreFactory;
  observability?: {
    telemetry: TelemetryPort;
    audit: AuditPort;
    metrics: MetricsPort;
  };
}

interface PersistenceComposition {
  close?: () => Promise<void>;
  store: RuntimeStore;
}

const assertDurableProviderKey = (providerKey: string): void => {
  if (
    providerKey.length === 0 ||
    providerKey.length > DURABLE_PROVIDER_KEY_MAX_LENGTH
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The composed provider identity is invalid.",
    );
  }
};

const onceAsync = (
  operation: () => Promise<void>,
): (() => Promise<void>) => {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(operation);
    return result;
  };
};

const createPostgresRuntimeStore: PostgresRuntimeStoreFactory = async (
  options,
) => {
  const moduleName: string = "@skein-chatbot/postgres";
  const moduleValue: unknown = await import(moduleName);
  if (typeof moduleValue !== "object" || moduleValue === null) {
    throw new TypeError("The PostgreSQL persistence package is unavailable.");
  }
  const factory = (moduleValue as Record<string, unknown>)[
    "createPostgresRuntimeStore"
  ];
  if (typeof factory !== "function") {
    throw new TypeError("The PostgreSQL store factory is unavailable.");
  }
  return (factory as PostgresRuntimeStoreFactory)(options);
};

const createOrchestrator = async (
  config: ApiConfig,
): Promise<OrchestratorComposition> => {
  if (config.orchestratorProvider === "mock") {
    return {
      orchestrator: new MockBusinessOrchestrator(),
      provider: "mock",
      providerKey: config.providerKey,
    };
  }

  const profile = await loadDifyProfile({
    name: config.dify.profile,
    ...(config.dify.profileDirectory === undefined
      ? {}
      : { directory: config.dify.profileDirectory }),
  });
  const providerFetch = globalThis.fetch;
  const orchestrator = createDifyBusinessOrchestrator({
    baseUrl: config.dify.baseUrl,
    apiKey: config.dify.apiKey,
    profile,
    fetch: providerFetch,
    ...(config.providerKeyPrefix === undefined
      ? {}
      : { providerKey: config.providerKeyPrefix }),
  });
  return {
    conversationHistorySource: createDifyConversationHistorySource({
      baseUrl: config.dify.baseUrl,
      apiKey: config.dify.apiKey,
      fetch: providerFetch,
    }),
    orchestrator,
    provider: "dify",
    providerKey: orchestrator.providerKey,
    resumeTokenCodec: createEncryptedResumeTokenCodec(
      config.sessionResumeSecret,
    ),
  };
};

const createPersistence = async (
  config: ApiConfig,
  dependencies: ApiRuntimeCompositionDependencies,
): Promise<PersistenceComposition> => {
  if (config.persistence.kind === "memory") {
    return { store: new InMemoryRuntimeStore() };
  }

  const factory =
    dependencies.createPostgresRuntimeStore ?? createPostgresRuntimeStore;
  try {
    const handle = await factory({
      databaseUrl: config.persistence.databaseUrl,
    });
    return {
      store: handle.store,
      close: onceAsync(() => handle.disconnect()),
    };
  } catch {
    // Never let a driver error serialize a credential-bearing connection URL.
    throw new Error("PostgreSQL persistence initialization failed.");
  }
};

/** API composition root; provider and persistence are replaceable at this boundary. */
export const createDefaultApiRuntime = async (
  config: ApiConfig,
  dependencies: ApiRuntimeCompositionDependencies = {},
): Promise<ApiRuntime> => {
  const composition = await createOrchestrator(config);
  assertDurableProviderKey(composition.providerKey);
  const persistence = await createPersistence(config, dependencies);
  const reliableOrchestrator = createReliableBusinessOrchestrator({
    orchestrator: composition.orchestrator,
    providerKey: `${composition.provider}:${composition.providerKey}`,
    config: config.runtime,
  });
  const runtime = new ChatRuntime({
    orchestrator: reliableOrchestrator,
    store: persistence.store,
    config: config.runtime,
    provider: composition.provider,
    providerKey: composition.providerKey,
    ...(composition.resumeTokenCodec === undefined
      ? {}
      : {
          resumeTokenCodec: composition.resumeTokenCodec,
          conversationHistorySource:
            composition.conversationHistorySource,
        }),
    ...(dependencies.observability ?? {}),
  });
  return persistence.close === undefined
    ? runtime
    : Object.assign(runtime, { close: persistence.close });
};
