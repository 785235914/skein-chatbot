import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryRuntimeStore } from "@skein-chatbot/test-utils";
import type {
  AuditEvent,
  MetricMeasurement,
  TelemetryEvent,
} from "@skein-chatbot/core";
import { RuntimeErrorCode } from "@skein-chatbot/core";

import { createDefaultApiRuntime } from "../src/composition.js";
import { loadApiConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("API Runtime composition", () => {
  it("injects one provider-neutral observability set into ChatRuntime", async () => {
    const telemetryEvents: TelemetryEvent[] = [];
    const auditEvents: AuditEvent[] = [];
    const measurements: MetricMeasurement[] = [];
    const runtime = await createDefaultApiRuntime(loadApiConfig({}), {
      observability: {
        telemetry: { record: (event) => telemetryEvents.push(event) },
        audit: { record: (event) => auditEvents.push(event) },
        metrics: { record: (measurement) => measurements.push(measurement) },
      },
    });

    await runtime.chat({ message: "safe", user: { userId: "demo-user" } });

    expect(telemetryEvents.map((event) => event.name)).toEqual([
      "TURN_COMPLETED",
    ]);
    expect(auditEvents.map((event) => event.name)).toEqual([
      "TURN_STARTED",
      "TURN_COMPLETED",
    ]);
    expect(measurements.map((measurement) => measurement.name)).toEqual(
      expect.arrayContaining([
        "provider_latency_ms",
        "chat_turn_total",
        "chat_turn_latency_ms",
      ]),
    );
  });

  it("keeps Mock as the provider-free default", async () => {
    const runtime = await createDefaultApiRuntime(loadApiConfig({}));
    const response = await runtime.chat({
      message: "Provider-free",
      user: { userId: "demo-user" },
    });

    expect(response).toMatchObject({
      answer: "Mock answer for: Provider-free",
      status: "ANSWER",
      metadata: {},
    });
  });

  it("does not load PostgreSQL when DATABASE_URL is missing", async () => {
    const createPostgresRuntimeStore = vi.fn();
    await createDefaultApiRuntime(loadApiConfig({}), {
      createPostgresRuntimeStore,
    });

    expect(createPostgresRuntimeStore).not.toHaveBeenCalled();
  });

  it("injects the configured PostgreSQL store and closes its handle once", async () => {
    const databaseUrl =
      "postgresql://placeholder:placeholder@127.0.0.1:5432/skein_chatbot?schema=public";
    const store = new InMemoryRuntimeStore();
    const disconnect = vi.fn(() => Promise.resolve());
    const createPostgresRuntimeStore = vi.fn(() =>
      Promise.resolve({ store, disconnect }),
    );
    const runtime = await createDefaultApiRuntime(
      loadApiConfig({ DATABASE_URL: databaseUrl }),
      { createPostgresRuntimeStore },
    );

    const response = await runtime.chat({
      message: "Persist through the injected store",
      user: { userId: "demo-user" },
    });

    expect(createPostgresRuntimeStore).toHaveBeenCalledOnce();
    expect(createPostgresRuntimeStore).toHaveBeenCalledWith({ databaseUrl });
    expect(await store.getSession(response.sessionId)).toMatchObject({
      id: response.sessionId,
      revision: 1,
    });
    await runtime.close?.();
    await runtime.close?.();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("sanitizes PostgreSQL factory failures", async () => {
    const password = "composition-password-must-not-leak";
    const databaseUrl = `postgresql://skein:${password}@127.0.0.1:5432/skein_chatbot`;
    const createPostgresRuntimeStore = vi.fn(
      async (options: { databaseUrl: string }) => {
        throw new Error(`Connection failed for ${options.databaseUrl}`);
      },
    );
    let captured: unknown;
    try {
      await createDefaultApiRuntime(
        loadApiConfig({ DATABASE_URL: databaseUrl }),
        { createPostgresRuntimeStore },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(String(captured)).toBe(
      "Error: PostgreSQL persistence initialization failed.",
    );
    expect(String(captured)).not.toContain(password);
    expect(JSON.stringify(captured)).not.toContain(databaseUrl);
  });

  it("loads a Dify profile and uses its namespaced provider identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "skein-api-profile-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "finance.yaml"), "name: finance\n", {
      encoding: "utf8",
    });

    const apiKey = "composition-test-app-key";
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            answer: "Dify composition answer",
            conversation_id: "external-conversation",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = loadApiConfig({
      ORCHESTRATOR_PROVIDER: "dify",
      ORCHESTRATOR_PROVIDER_KEY: "tenant-a",
      DIFY_BASE_URL: "https://api.example.com/v1",
      DIFY_API_KEY: apiKey,
      DIFY_PROFILE: "finance",
      DIFY_PROFILE_DIRECTORY: directory,
    });
    const runtime = await createDefaultApiRuntime(config);
    const response = await runtime.chat({
      message: "Use Dify",
      mode: "deep",
      user: { userId: "demo-user" },
    });

    expect(response).toMatchObject({
      answer: "Dify composition answer",
      status: "ANSWER",
      metadata: {},
    });
    expect(JSON.stringify(response)).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://api.example.com/v1/chat-messages",
    );
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );

    const dependencies = (
      runtime as unknown as {
        dependencies: { provider: string; providerKey: string };
      }
    ).dependencies;
    expect(dependencies).toMatchObject({
      provider: "dify",
      providerKey: "tenant-a:finance",
    });
  });

  it("rejects a 192-character composed Dify provider key before persistence or provider activity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "skein-api-profile-"));
    temporaryDirectories.push(directory);
    const profileName = "p".repeat(128);
    const providerKeyPrefix = "n".repeat(63);
    const composedProviderKey = `${providerKeyPrefix}:${profileName}`;
    expect(composedProviderKey).toHaveLength(192);
    await writeFile(path.join(directory, "long-profile.yaml"), `name: ${profileName}\n`, {
      encoding: "utf8",
    });

    const databaseUrl =
      "postgresql://placeholder:placeholder@127.0.0.1:5432/skein_chatbot";
    const createPostgresRuntimeStore = vi.fn(() =>
      Promise.resolve({
        store: new InMemoryRuntimeStore(),
        disconnect: () => Promise.resolve(),
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = loadApiConfig({
      ORCHESTRATOR_PROVIDER: "dify",
      ORCHESTRATOR_PROVIDER_KEY: providerKeyPrefix,
      DIFY_BASE_URL: "https://api.example.com/v1",
      DIFY_API_KEY: "long-identity-test-key",
      DIFY_PROFILE: "long-profile",
      DIFY_PROFILE_DIRECTORY: directory,
      DATABASE_URL: databaseUrl,
    });

    let captured: unknown;
    try {
      await createDefaultApiRuntime(config, { createPostgresRuntimeStore });
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      code: RuntimeErrorCode.VALIDATION_ERROR,
      message: "The composed provider identity is invalid.",
    });
    expect(JSON.stringify(captured)).not.toContain(composedProviderKey);
    expect(JSON.stringify(captured)).not.toContain(databaseUrl);
    expect(createPostgresRuntimeStore).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries retryable Dify 5xx responses using RETRY_ATTEMPTS", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "skein-api-profile-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "finance.yaml"), "name: finance\n", {
      encoding: "utf8",
    });

    let providerAttempts = 0;
    const fetchMock = vi.fn(async () => {
      providerAttempts += 1;
      if (providerAttempts < 3) {
        return new Response(
          JSON.stringify({
            code: "internal_server_error",
            message: "sensitive provider detail",
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          answer: "Recovered Dify answer",
          conversation_id: "external-conversation",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await createDefaultApiRuntime(
      loadApiConfig({
        ORCHESTRATOR_PROVIDER: "dify",
        DIFY_BASE_URL: "https://api.example.com/v1",
        DIFY_API_KEY: "retry-test-app-key",
        DIFY_PROFILE: "finance",
        DIFY_PROFILE_DIRECTORY: directory,
        RETRY_ATTEMPTS: "2",
      }),
    );
    const response = await runtime.chat({
      message: "Retry Dify",
      user: { userId: "demo-user" },
    });

    expect(response).toMatchObject({
      answer: "Recovered Dify answer",
      status: "ANSWER",
      metadata: {},
    });
    expect(JSON.stringify(response)).not.toContain("sensitive provider detail");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails profile loading without exposing the configured app key", async () => {
    const apiKey = "missing-profile-secret-key";
    const directory = await mkdtemp(path.join(tmpdir(), "skein-api-profile-"));
    temporaryDirectories.push(directory);
    const config = loadApiConfig({
      ORCHESTRATOR_PROVIDER: "dify",
      DIFY_BASE_URL: "https://api.example.com/v1",
      DIFY_API_KEY: apiKey,
      DIFY_PROFILE: "missing",
      DIFY_PROFILE_DIRECTORY: directory,
    });

    let captured: unknown;
    try {
      await createDefaultApiRuntime(config);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(String(captured)).not.toContain(apiKey);
  });
});
