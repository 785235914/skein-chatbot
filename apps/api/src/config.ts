import { z } from "zod";

import type { RuntimeConfig } from "@skein-chatbot/core";
import {
  PINO_LOG_LEVELS,
  type PinoLogLevel,
} from "@skein-chatbot/observability";

const BooleanEnvironmentValueSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const PositiveIntegerSchema = z.coerce.number().int().positive();
const NonNegativeIntegerSchema = z.coerce.number().int().nonnegative();
const OptionalDatabaseUrlSchema = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim().length === 0 ? undefined : value,
  );
const ProviderKeySchema = z.string().trim().min(1).max(128);
const SessionResumeSecretSchema = z
  .string()
  .min(1)
  .transform((value, context): Uint8Array => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SESSION_RESUME_SECRET must be strict Base64.",
      });
      return z.NEVER;
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value || decoded.byteLength !== 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SESSION_RESUME_SECRET must decode to exactly 32 bytes.",
      });
      return z.NEVER;
    }
    return new Uint8Array(decoded);
  });
const PinoLogLevelSchema = z.enum(PINO_LOG_LEVELS);
const ProfileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const DifyBaseUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username.length === 0 &&
        parsed.password.length === 0 &&
        parsed.search.length === 0 &&
        parsed.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "DIFY_BASE_URL must be an HTTP(S) URL without credentials or parameters.");

const CommonEnvironmentShape = {
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: PinoLogLevelSchema,
  DATABASE_URL: OptionalDatabaseUrlSchema,
  DEFAULT_MODE: z.enum(["quick", "deep"]).default("quick"),
  MEMORY_RECENT_MESSAGES: PositiveIntegerSchema.default(8),
  COMPACTION_MESSAGE_THRESHOLD: PositiveIntegerSchema.default(20),
  COMPACTION_TOKEN_THRESHOLD: PositiveIntegerSchema.default(12_000),
  QUICK_TIMEOUT_MS: PositiveIntegerSchema.default(25_000),
  DEEP_TIMEOUT_MS: PositiveIntegerSchema.default(60_000),
  RETRY_ATTEMPTS: NonNegativeIntegerSchema.max(10).default(1),
  ENABLE_INPUT_GUARD: BooleanEnvironmentValueSchema.default("true"),
  ENABLE_OUTPUT_GUARD: BooleanEnvironmentValueSchema.default("true"),
  SESSION_RESUME_SECRET: SessionResumeSecretSchema.optional(),
} as const;

const MockEnvironmentSchema = z.object({
  ...CommonEnvironmentShape,
  ORCHESTRATOR_PROVIDER: z.literal("mock"),
  ORCHESTRATOR_PROVIDER_KEY: ProviderKeySchema.default("default"),
});

const DifyEnvironmentSchema = z.object({
  ...CommonEnvironmentShape,
  ORCHESTRATOR_PROVIDER: z.literal("dify"),
  ORCHESTRATOR_PROVIDER_KEY: ProviderKeySchema.optional(),
  DIFY_BASE_URL: DifyBaseUrlSchema,
  DIFY_API_KEY: z
    .string()
    .min(1)
    .max(8_192)
    .refine((value) => value.trim().length > 0, "DIFY_API_KEY is required."),
  DIFY_PROFILE: ProfileNameSchema,
  DIFY_PROFILE_DIRECTORY: z.string().min(1).optional(),
  SESSION_RESUME_SECRET: SessionResumeSecretSchema,
});

const EnvironmentSchema = z.discriminatedUnion("ORCHESTRATOR_PROVIDER", [
  MockEnvironmentSchema,
  DifyEnvironmentSchema,
]);

interface CommonApiConfig {
  host: string;
  logLevel: PinoLogLevel;
  nodeEnv: "development" | "test" | "production";
  persistence: ApiPersistenceConfig;
  port: number;
  runtime: RuntimeConfig;
  sessionResumeSecret?: Uint8Array;
}

export type ApiPersistenceConfig =
  | { kind: "memory" }
  | { databaseUrl: string; kind: "postgres" };

export interface MockApiConfig extends CommonApiConfig {
  orchestratorProvider: "mock";
  providerKey: string;
}

export interface DifyApiConfig extends CommonApiConfig {
  orchestratorProvider: "dify";
  sessionResumeSecret: Uint8Array;
  dify: {
    apiKey: string;
    baseUrl: string;
    profile: string;
    profileDirectory?: string;
  };
  providerKeyPrefix?: string;
}

export type ApiConfig = MockApiConfig | DifyApiConfig;

const runtimeConfigFrom = (
  parsed: z.infer<typeof EnvironmentSchema>,
): RuntimeConfig => ({
  defaultMode: parsed.DEFAULT_MODE === "quick" ? "QUICK" : "DEEP",
  recentMessages: parsed.MEMORY_RECENT_MESSAGES,
  compactionMessageThreshold: parsed.COMPACTION_MESSAGE_THRESHOLD,
  compactionTokenThreshold: parsed.COMPACTION_TOKEN_THRESHOLD,
  quickTimeoutMs: parsed.QUICK_TIMEOUT_MS,
  deepTimeoutMs: parsed.DEEP_TIMEOUT_MS,
  retryAttempts: parsed.RETRY_ATTEMPTS,
  guards: {
    input: parsed.ENABLE_INPUT_GUARD,
    output: parsed.ENABLE_OUTPUT_GUARD,
  },
});

const persistenceConfigFrom = (
  databaseUrl: string | undefined,
): ApiPersistenceConfig =>
  databaseUrl === undefined
    ? { kind: "memory" }
    : { databaseUrl, kind: "postgres" };

export const loadApiConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig => {
  const provider = environment.ORCHESTRATOR_PROVIDER ?? "mock";
  const logLevel = PinoLogLevelSchema.safeParse(environment.LOG_LEVEL ?? "info");
  if (!logLevel.success) {
    throw new Error("LOG_LEVEL is invalid.");
  }
  const parsed = EnvironmentSchema.parse({
    ...environment,
    ORCHESTRATOR_PROVIDER: provider,
    LOG_LEVEL: logLevel.data,
  });
  const common: CommonApiConfig = {
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    persistence: persistenceConfigFrom(parsed.DATABASE_URL),
    port: parsed.PORT,
    runtime: runtimeConfigFrom(parsed),
    ...(parsed.SESSION_RESUME_SECRET === undefined
      ? {}
      : { sessionResumeSecret: parsed.SESSION_RESUME_SECRET }),
  };

  if (parsed.ORCHESTRATOR_PROVIDER === "mock") {
    return {
      ...common,
      orchestratorProvider: "mock",
      providerKey: parsed.ORCHESTRATOR_PROVIDER_KEY,
    };
  }

  return {
    ...common,
    orchestratorProvider: "dify",
    sessionResumeSecret: parsed.SESSION_RESUME_SECRET,
    dify: {
      apiKey: parsed.DIFY_API_KEY,
      baseUrl: parsed.DIFY_BASE_URL,
      profile: parsed.DIFY_PROFILE,
      ...(parsed.DIFY_PROFILE_DIRECTORY === undefined
        ? {}
        : { profileDirectory: parsed.DIFY_PROFILE_DIRECTORY }),
    },
    ...(parsed.ORCHESTRATOR_PROVIDER_KEY === undefined
      ? {}
      : { providerKeyPrefix: parsed.ORCHESTRATOR_PROVIDER_KEY }),
  };
};

/** Values and validation messages may contain secrets; return field names only. */
export const diagnoseApiConfig = (environment: NodeJS.ProcessEnv) => {
  try {
    const config = loadApiConfig(environment);
    return {
      status: "PASS" as const,
      provider: config.orchestratorProvider,
      persistence: config.persistence.kind,
      restartRecovery: config.orchestratorProvider === "dify",
      invalidFields: [] as string[],
    };
  } catch (error) {
    const knownFields = new Set([
      ...Object.keys(CommonEnvironmentShape),
      ...Object.keys(DifyEnvironmentSchema.shape),
      ...Object.keys(MockEnvironmentSchema.shape),
    ]);
    const invalidFields = error instanceof z.ZodError
      ? [...new Set(error.issues.map((issue) => String(issue.path[0])))]
          .filter((field) => knownFields.has(field)).sort()
      : ["LOG_LEVEL"];
    return { status: "FAIL" as const, invalidFields };
  }
};
