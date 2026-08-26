// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResumeSessionResponse, RuntimeEvent } from "@skein-chatbot/contracts";

import { App } from "./App.js";
import {
  loadConversationCache,
  saveConversationCache,
  type BrowserConversationCache,
} from "./conversation-cache.js";

const cachedDocument = (
  overrides: Partial<BrowserConversationCache> = {},
): BrowserConversationCache => ({
  version: 1,
  activeSessionId: "session-1",
  conversations: [
    {
      sessionId: "session-1",
      resumeToken: "opaque-token",
      title: "Cached conversation",
      updatedAt: "2026-08-25T00:00:01.000Z",
      messages: [
        {
          id: "cached-user",
          role: "USER",
          content: "Cached question",
          createdAt: "2026-08-25T00:00:00.000Z",
        },
        {
          id: "cached-assistant",
          role: "ASSISTANT",
          content: "Cached answer",
          createdAt: "2026-08-25T00:00:01.000Z",
        },
      ],
    },
  ],
  ...overrides,
});

const restoredResponse = (
  overrides: Partial<ResumeSessionResponse> = {},
): ResumeSessionResponse => ({
  session: {
    id: "session-1",
    userId: "demo-user",
    status: "ACTIVE",
    revision: 0,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:03.000Z",
    lastActiveAt: "2026-08-25T00:00:03.000Z",
  },
  messages: [
    {
      id: "restored-user",
      sessionId: "session-1",
      role: "USER",
      content: "Canonical restored question",
      createdAt: "2026-08-25T00:00:00.000Z",
    },
    {
      id: "restored-assistant",
      sessionId: "session-1",
      role: "ASSISTANT",
      content: "Canonical restored answer",
      createdAt: "2026-08-25T00:00:01.000Z",
    },
  ],
  resumeToken: "refreshed-token",
  ...overrides,
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("App conversation persistence", () => {
  it("shows cached history immediately, then replaces it with canonical restored history", async () => {
    saveConversationCache(localStorage, cachedDocument());
    let resolveResume = (_response: Response): void => undefined;
    const pendingResume = new Promise<Response>((resolve) => {
      resolveResume = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((_input, _init) => pendingResume);
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(screen.getByText("Cached answer")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Restoring conversation",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("/api/v1/sessions/resume");
    expect(String(requestUrl)).not.toContain("opaque-token");
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      resumeToken: "opaque-token",
    });

    resolveResume(
      new Response(JSON.stringify(restoredResponse()), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    expect(await screen.findByText("Canonical restored answer")).toBeTruthy();
    expect(screen.queryByText("Cached answer")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveProperty(
      "disabled",
      true,
    );
    expect(loadConversationCache(localStorage).cache).toMatchObject({
      activeSessionId: "session-1",
      conversations: [
        {
          resumeToken: "refreshed-token",
          messages: [
            { content: "Canonical restored question", role: "USER" },
            { content: "Canonical restored answer", role: "ASSISTANT" },
          ],
        },
      ],
    });
  });

  it("keeps cached content read-only and offers retry when recovery fails", async () => {
    saveConversationCache(localStorage, cachedDocument());
    const publicError = {
      code: "SESSION_NOT_FOUND",
      message: "The session was not found.",
      retryable: false,
      traceId: "trace-1",
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(publicError), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByText(/Cached messages are read-only\./u),
    ).toBeTruthy();
    expect(screen.getByText("Cached answer")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry recovery" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("starts a new local conversation without deleting saved history", async () => {
    const {
      resumeToken: _resumeToken,
      ...conversationWithoutToken
    } = cachedDocument().conversations[0]!;
    const documentWithoutToken = cachedDocument({
      conversations: [conversationWithoutToken],
    });
    saveConversationCache(localStorage, documentWithoutToken);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(screen.getByText("Cached answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    expect(screen.getByText("Start a test conversation")).toBeTruthy();
    expect(loadConversationCache(localStorage).cache).toMatchObject({
      version: 1,
      conversations: [{ sessionId: "session-1" }],
    });
    expect(loadConversationCache(localStorage).cache.activeSessionId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not offer an impossible recovery retry after a tokenless session is lost", async () => {
    const {
      resumeToken: _resumeToken,
      ...conversationWithoutToken
    } = cachedDocument().conversations[0]!;
    saveConversationCache(
      localStorage,
      cachedDocument({ conversations: [conversationWithoutToken] }),
    );
    const failedEvent: RuntimeEvent = {
      type: "turn.failed",
      error: {
        code: "SESSION_NOT_FOUND",
        message: "The session was not found.",
        retryable: false,
        traceId: "trace-missing-session",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            `event: turn.failed\ndata: ${JSON.stringify(failedEvent)}\n\n`,
            {
              headers: { "content-type": "text/event-stream" },
              status: 200,
            },
          ),
        ),
      ),
    );
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Continue cached session" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(/Cached messages are read-only\./u),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Retry recovery" }),
    ).toBeNull();
  });

  it("persists terminal stream messages and the opaque resume token", async () => {
    const completedEvent: RuntimeEvent = {
      type: "turn.completed",
      result: {
        sessionId: "session-new",
        turnId: "turn-new",
        answer: "Persisted answer",
        status: "ANSWER",
        sources: [],
        followUpQuestion: "",
        followUpGuidance: "",
        metadata: {},
        resumeToken: "new-opaque-token",
      },
    };
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          `event: turn.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Persist this conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Persisted answer")).toBeTruthy();
    await waitFor(() => {
      expect(loadConversationCache(localStorage).cache).toMatchObject({
        activeSessionId: "session-new",
        conversations: [
          {
            sessionId: "session-new",
            resumeToken: "new-opaque-token",
            title: "Persist this conversation",
            messages: [
              { content: "Persist this conversation", role: "USER" },
              { content: "Persisted answer", role: "ASSISTANT" },
            ],
          },
        ],
      });
    });
  });
});
