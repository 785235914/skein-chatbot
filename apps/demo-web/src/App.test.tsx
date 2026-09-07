// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResumeSessionResponse, RuntimeEvent } from "@skein-chatbot/contracts";

import { App } from "./App.js";
import {
  CONVERSATION_CACHE_KEY,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("App conversation persistence", () => {
  it("renders a usable composer when browser storage access is denied", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    render(<App />);
    expect(screen.getByText("Saved conversations could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("disabled", false);
  });

  it("allows leaving a pending recovery and ignores its late response", async () => {
    saveConversationCache(localStorage, cachedDocument());
    let resolveResume!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveResume = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByText("Start a test conversation")).toBeTruthy();
    await act(async () => {
      resolveResume(new Response(JSON.stringify(restoredResponse())));
      await pending;
    });
    expect(screen.queryByText("Canonical restored answer")).toBeNull();
    expect(loadConversationCache(localStorage).cache.activeSessionId).toBeUndefined();
  });

  it("times out a stalled recovery while preserving cached history", async () => {
    vi.useFakeTimers();
    saveConversationCache(localStorage, cachedDocument());
    const persisted = localStorage.getItem(CONVERSATION_CACHE_KEY);
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("button", { name: "Retry recovery" })).toBeTruthy();
    expect(screen.getByText("Cached answer")).toBeTruthy();
    expect(localStorage.getItem(CONVERSATION_CACHE_KEY)).toBe(persisted);
  });

  it("searches saved sessions and keeps drafts with their selected conversation", () => {
    const first = { ...cachedDocument().conversations[0]!, resumeToken: undefined };
    const second = { ...first, sessionId: "session-2", title: "Second conversation", messages: [] };
    saveConversationCache(localStorage, cachedDocument({ conversations: [first, second] }));
    render(<App />);
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Draft for first" } });
    const search = screen.getByRole("searchbox", { name: "Search conversations" });
    fireEvent.change(search, { target: { value: "session-2" } });
    expect(screen.queryByRole("button", { name: /Cached conversation/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Second conversation/u }));
    expect(composer).toHaveProperty("value", "");
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Cached conversation/u }));
    expect(composer).toHaveProperty("value", "Draft for first");
    expect(loadConversationCache(localStorage).cache.activeSessionId).toBe("session-1");
  });

  it("refreshes canonical history using the renewed opaque token", async () => {
    saveConversationCache(localStorage, cachedDocument());
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)));
      const response = restoredResponse();
      if (requests.length === 2) response.messages[1]!.content = "Updated canonical answer";
      return Promise.resolve(new Response(JSON.stringify(response)));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh history" }));
    expect(await screen.findByText("Updated canonical answer")).toBeTruthy();
    expect(requests).toEqual([{ resumeToken: "opaque-token" }, { resumeToken: "refreshed-token" }]);
  });

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

  it("keeps a successful recovery active when canonical history exceeds the cache limit", async () => {
    saveConversationCache(localStorage, cachedDocument());
    const originalPersisted = localStorage.getItem(CONVERSATION_CACHE_KEY);
    const messages = Array.from({ length: 401 }, (_, index) => ({
      id: `restored-message-${index}`,
      sessionId: "session-1",
      role: index % 2 === 0 ? ("USER" as const) : ("ASSISTANT" as const),
      content: `Canonical message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(restoredResponse({ messages })),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
        ),
      ),
    );

    render(<App />);

    expect(await screen.findByText("Canonical message 400")).toBeTruthy();
    expect(
      await screen.findByText("Saved conversations could not be updated."),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByText(/Cached messages are read-only\./u)).toBeNull();
    expect(localStorage.getItem(CONVERSATION_CACHE_KEY)).toBe(
      originalPersisted,
    );
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

  it("returns focus to the history opener when the drawer close button is used", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<App />);
    const opener = screen.getByRole("button", {
      name: "Conversation history",
    });

    fireEvent.click(opener);
    const closeButton = screen.getByRole("button", {
      name: "Close conversation history",
    });
    closeButton.focus();
    fireEvent.click(closeButton);

    expect(document.activeElement).toBe(opener);
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

  it("warns without overwriting cached history when a completed turn exceeds the message limit", async () => {
    const fullConversation = {
      ...cachedDocument().conversations[0]!,
      resumeToken: undefined,
      messages: Array.from({ length: 400 }, (_, index) => ({
        id: `cached-message-${index}`,
        role: index % 2 === 0 ? ("USER" as const) : ("ASSISTANT" as const),
        content: `Cached message ${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString(),
      })),
    };
    const fullCache = cachedDocument({ conversations: [fullConversation] });
    expect(saveConversationCache(localStorage, fullCache)).toEqual({
      saved: true,
    });
    const originalPersisted = localStorage.getItem(CONVERSATION_CACHE_KEY);
    const completedEvent: RuntimeEvent = {
      type: "turn.completed",
      result: {
        sessionId: "session-1",
        turnId: "turn-over-limit",
        answer: "Answer beyond the cache limit",
        status: "ANSWER",
        sources: [],
        followUpQuestion: "",
        followUpGuidance: "",
        metadata: {},
        resumeToken: "refreshed-token",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            `event: turn.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`,
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
      target: { value: "Question beyond the cache limit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText("Saved conversations could not be updated."),
    ).toBeTruthy();
    expect(localStorage.getItem(CONVERSATION_CACHE_KEY)).toBe(
      originalPersisted,
    );
  });
});
