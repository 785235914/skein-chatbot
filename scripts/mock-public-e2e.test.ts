import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createApiApp } from "../apps/api/src/app.js";
import { createDefaultApiRuntime } from "../apps/api/src/composition.js";
import { loadApiConfig } from "../apps/api/src/config.js";
import { createApiClient } from "../apps/demo-web/src/api.js";

const apps: Awaited<ReturnType<typeof createApiApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("provider-free public Mock journey", () => {
  it("preserves the canonical REST and SSE journey through the Demo client", async () => {
    const config = loadApiConfig({
      DATABASE_URL: "",
      LOG_LEVEL: "info",
      ORCHESTRATOR_PROVIDER: "mock",
    });
    const runtime = await createDefaultApiRuntime(config);
    const app = await createApiApp({ config, runtime });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createApiClient({ baseUrl });

    await expect(fetch(`${baseUrl}/api/v1/health`).then((response) => response.json())).resolves.toEqual({
      status: "ok",
    });
    await expect(fetch(`${baseUrl}/api/v1/ready`).then((response) => response.json())).resolves.toEqual({
      checks: { runtime: true },
      status: "ready",
    });

    const first = await client.chat({
      message: "Find a source",
      metadata: { mockScenario: "sources" },
      mode: "quick",
    });
    expect(first).toMatchObject({
      answer: "Mock sourced answer for: Find a source",
      sources: [
        {
          id: "mock-source-1",
          provider: "mock",
          title: "Mock reference",
          url: "https://example.com/reference",
        },
      ],
      status: "ANSWER",
    });

    const followUp = await client.chat({
      message: "Continue the work",
      metadata: { mockScenario: "handoff" },
      mode: "deep",
      sessionId: first.sessionId,
    });
    expect(followUp).toMatchObject({
      followUpGuidance: "Continue with a human support channel.",
      sessionId: first.sessionId,
      status: "HANDOFF",
    });

    const session = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}`).then(
      (response) => response.json(),
    );
    expect(session).toMatchObject({ id: first.sessionId, revision: 2, status: "ACTIVE" });
    const messages = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/messages`).then(
      (response) => response.json() as Promise<{ messages: Array<{ content: string; role: string }> }>,
    );
    expect(messages.messages.map(({ content, role }) => ({ content, role }))).toEqual([
      { content: "Find a source", role: "USER" },
      { content: "Mock sourced answer for: Find a source", role: "ASSISTANT" },
      { content: "Continue the work", role: "USER" },
      { content: "Mock handoff response for: Continue the work", role: "ASSISTANT" },
    ]);

    const events = [] as Array<{ type: string }>;
    for await (const event of client.streamChat({
      message: "Stream this",
      metadata: { mockScenario: "stream" },
      sessionId: first.sessionId,
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "status.changed",
      "assistant.delta",
      "assistant.delta",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed")).toHaveLength(1);

    const reset = await fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/reset`, {
      method: "POST",
    }).then((response) => response.json());
    expect(reset).toMatchObject({ sessionId: first.sessionId, status: "RESET" });
    await expect(
      fetch(`${baseUrl}/api/v1/sessions/${first.sessionId}/messages`).then((response) => response.json()),
    ).resolves.toEqual({ messages: [] });
  });
});
