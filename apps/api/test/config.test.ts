import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadApiConfig } from "../src/config.js";

const sessionResumeSecret = Buffer.alloc(32, 7).toString("base64");

describe("API environment configuration", () => {
  it("provides a fully validated provider-free Runtime configuration", () => {
    expect(loadApiConfig({})).toEqual({
      host: "127.0.0.1",
      logLevel: "info",
      nodeEnv: "development",
      orchestratorProvider: "mock",
      persistence: { kind: "memory" },
      providerKey: "default",
      port: 3000,
      runtime: {
        defaultMode: "QUICK",
        recentMessages: 8,
        compactionMessageThreshold: 20,
        compactionTokenThreshold: 12_000,
        quickTimeoutMs: 25_000,
        deepTimeoutMs: 60_000,
        retryAttempts: 1,
        guards: { input: true, output: true },
      },
    });
  });

  it("accepts only conservative Pino log levels", () => {
    expect(loadApiConfig({ LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(loadApiConfig({ LOG_LEVEL: "silent" }).logLevel).toBe("silent");
    expect(() => loadApiConfig({ LOG_LEVEL: "verbose" })).toThrow();
    const secret = "secret-log-level-must-not-leak";
    let captured: unknown;
    try {
      loadApiConfig({ LOG_LEVEL: secret });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect(String(captured)).not.toContain(secret);
  });

  it("maps valid public environment values to canonical Runtime values", () => {
    const config = loadApiConfig({
      DEFAULT_MODE: "deep",
      MEMORY_RECENT_MESSAGES: "12",
      COMPACTION_MESSAGE_THRESHOLD: "30",
      COMPACTION_TOKEN_THRESHOLD: "15000",
      QUICK_TIMEOUT_MS: "1000",
      DEEP_TIMEOUT_MS: "2000",
      RETRY_ATTEMPTS: "2",
      ENABLE_INPUT_GUARD: "false",
      ENABLE_OUTPUT_GUARD: "true",
      ORCHESTRATOR_PROVIDER_KEY: "local",
    });

    expect(config.runtime).toEqual({
      defaultMode: "DEEP",
      recentMessages: 12,
      compactionMessageThreshold: 30,
      compactionTokenThreshold: 15_000,
      quickTimeoutMs: 1_000,
      deepTimeoutMs: 2_000,
      retryAttempts: 2,
      guards: { input: false, output: true },
    });
    if (config.orchestratorProvider !== "mock") {
      throw new Error("Expected Mock configuration.");
    }
    expect(config.providerKey).toBe("local");
  });

  it("selects PostgreSQL only for a nonempty DATABASE_URL and preserves it exactly", () => {
    const databaseUrl =
      "postgresql://placeholder:placeholder@127.0.0.1:5432/skein_chatbot?schema=public";

    expect(loadApiConfig({}).persistence).toEqual({ kind: "memory" });
    expect(loadApiConfig({ DATABASE_URL: "" }).persistence).toEqual({
      kind: "memory",
    });
    expect(loadApiConfig({ DATABASE_URL: "   " }).persistence).toEqual({
      kind: "memory",
    });
    expect(loadApiConfig({ DATABASE_URL: databaseUrl }).persistence).toEqual({
      kind: "postgres",
      databaseUrl,
    });
  });

  it("requires and maps Dify-only configuration conditionally", () => {
    const config = loadApiConfig({
      ORCHESTRATOR_PROVIDER: "dify",
      ORCHESTRATOR_PROVIDER_KEY: "tenant-a",
      DIFY_BASE_URL: "https://api.example.com/v1",
      DIFY_API_KEY: "test-app-key",
      DIFY_PROFILE: "finance",
      DIFY_PROFILE_DIRECTORY: "C:\\profiles",
      SESSION_RESUME_SECRET: sessionResumeSecret,
    });

    expect(config.orchestratorProvider).toBe("dify");
    if (config.orchestratorProvider !== "dify") {
      throw new Error("Expected Dify configuration.");
    }
    expect(config.dify).toEqual({
      apiKey: "test-app-key",
      baseUrl: "https://api.example.com/v1",
      profile: "finance",
      profileDirectory: "C:\\profiles",
    });
    expect(config.providerKeyPrefix).toBe("tenant-a");
    expect(config.sessionResumeSecret).toEqual(new Uint8Array(32).fill(7));
  });

  it.each([
    "DIFY_BASE_URL",
    "DIFY_API_KEY",
    "DIFY_PROFILE",
    "SESSION_RESUME_SECRET",
  ] as const)(
    "requires %s when the Dify provider is selected",
    (missingName) => {
      const environment: NodeJS.ProcessEnv = {
        ORCHESTRATOR_PROVIDER: "dify",
        DIFY_BASE_URL: "https://api.example.com/v1",
        DIFY_API_KEY: "test-app-key",
        DIFY_PROFILE: "default",
        SESSION_RESUME_SECRET: sessionResumeSecret,
      };
      delete environment[missingName];
      expect(() => loadApiConfig(environment)).toThrow();
    },
  );

  it("never includes a supplied API key in validation errors", () => {
    const secret = "secret-app-key-must-not-leak";
    let captured: unknown;
    try {
      loadApiConfig({
        ORCHESTRATOR_PROVIDER: "dify",
        DIFY_BASE_URL: "not-a-url",
        DIFY_API_KEY: secret,
        DIFY_PROFILE: "default",
        SESSION_RESUME_SECRET: sessionResumeSecret,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(captured).toBeInstanceOf(ZodError);
    expect(String(captured)).not.toContain(secret);
  });

  it("accepts an optional Mock resume secret but rejects malformed secret material", () => {
    const mock = loadApiConfig({ SESSION_RESUME_SECRET: sessionResumeSecret });
    expect(mock.sessionResumeSecret).toEqual(new Uint8Array(32).fill(7));

    for (const invalid of ["not-base64!", Buffer.alloc(31).toString("base64")]) {
      expect(() =>
        loadApiConfig({ SESSION_RESUME_SECRET: invalid }),
      ).toThrow("SESSION_RESUME_SECRET");
    }

    const credentialLikeValue = Buffer.alloc(31, 9).toString("base64");
    let captured: unknown;
    try {
      loadApiConfig({ SESSION_RESUME_SECRET: credentialLikeValue });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect(String(captured)).not.toContain(credentialLikeValue);
  });

  it("never includes a database URL or password in unrelated validation errors", () => {
    const password = "database-password-must-not-leak";
    const databaseUrl = `postgresql://skein:${password}@127.0.0.1:5432/skein_chatbot`;
    let captured: unknown;
    try {
      loadApiConfig({ DATABASE_URL: databaseUrl, PORT: "0" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(String(captured)).not.toContain(password);
    expect(JSON.stringify(captured)).not.toContain(databaseUrl);
  });

  it("rejects unsupported providers and malformed values at startup", () => {
    expect(() =>
      loadApiConfig({ ORCHESTRATOR_PROVIDER: "other" }),
    ).toThrow();
    expect(() =>
      loadApiConfig({ ENABLE_INPUT_GUARD: "yes" }),
    ).toThrow();
    expect(() => loadApiConfig({ QUICK_TIMEOUT_MS: "0" })).toThrow();
  });
});
