import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  ChatMode,
  ChatRequest,
  ChatStatus,
  MessageView,
  PublicError,
  Source,
} from "@skein-chatbot/contracts";

import { ApiClientError, createApiClient } from "./api.js";
import {
  activateCachedConversation,
  loadConversationCache,
  saveConversationCache,
  upsertCachedConversation,
  type BrowserConversationCache,
  type CachedConversation,
  type CachedMessage,
} from "./conversation-cache.js";
import {
  ConversationSidebar,
  type ConversationRecoveryState,
} from "./conversation-sidebar.js";
import { MarkdownMessage } from "./message-markdown.js";

type LocalRole = "assistant" | "user";

interface LocalMessage {
  id: string;
  role: LocalRole;
  content: string;
  createdAt: string;
  status?: ChatStatus;
  sources?: Source[];
  followUpQuestion?: string;
  followUpGuidance?: string;
  pending?: boolean;
}

interface DisplayError {
  message: string;
  retryable: boolean;
  traceId?: string;
}

const makeLocalId = (): string => crypto.randomUUID();

const cachedMessagesToLocal = (
  messages: readonly CachedMessage[],
): LocalMessage[] =>
  messages.map((message) => ({
    id: message.id,
    role: message.role === "USER" ? "user" : "assistant",
    content: message.content,
    createdAt: message.createdAt,
  }));

const restoredMessagesToLocal = (
  messages: readonly MessageView[],
): LocalMessage[] =>
  messages
    .filter(
      (message): message is MessageView & { role: "USER" | "ASSISTANT" } =>
        message.role === "USER" || message.role === "ASSISTANT",
    )
    .map((message) => ({
      id: message.id,
      role: message.role === "USER" ? "user" : "assistant",
      content: message.content,
      createdAt: message.createdAt,
    }));

const localMessagesToCache = (
  messages: readonly LocalMessage[],
): CachedMessage[] =>
  messages
    .filter((message) => message.pending !== true)
    .slice(-400)
    .map((message) => ({
      id: message.id,
      role: message.role === "user" ? "USER" : "ASSISTANT",
      content: message.content,
      createdAt: message.createdAt,
    }));

const titleFromMessages = (messages: readonly LocalMessage[]): string => {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const normalized = (firstUserMessage?.content ?? "Conversation")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized || "Conversation").slice(0, 160).join("");
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const toDisplayError = (error: unknown): DisplayError => {
  if (error instanceof ApiClientError) {
    return {
      message: error.message,
      retryable: error.publicError?.retryable ?? true,
      ...(error.publicError?.traceId === undefined
        ? {}
        : { traceId: error.publicError.traceId }),
    };
  }

  return {
    message: error instanceof Error ? error.message : "The request failed.",
    retryable: true,
  };
};

export function App() {
  const client = useMemo(
    () =>
      createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "" }),
    [],
  );
  const [initialCacheLoad] = useState(() =>
    loadConversationCache(window.localStorage),
  );
  const initialConversation = initialCacheLoad.cache.conversations.find(
    (conversation) =>
      conversation.sessionId === initialCacheLoad.cache.activeSessionId,
  );
  const [browserCache, setBrowserCache] = useState<BrowserConversationCache>(
    initialCacheLoad.cache,
  );
  const cacheRef = useRef(browserCache);
  const cachePersistenceEnabled = useRef(
    initialCacheLoad.warning === undefined,
  );
  const [messages, setMessageState] = useState<LocalMessage[]>(() =>
    initialConversation === undefined
      ? []
      : cachedMessagesToLocal(initialConversation.messages),
  );
  const messagesRef = useRef(messages);
  const [sessionId, setSessionId] = useState<string | undefined>(
    initialConversation?.sessionId,
  );
  const [mode, setMode] = useState<ChatMode>("quick");
  const [draft, setDraft] = useState("");
  const [statusText, setStatusText] = useState(
    initialConversation?.resumeToken === undefined ? "Ready" : "Restoring",
  );
  const [displayError, setDisplayError] = useState<DisplayError>();
  const [lastFailedMessage, setLastFailedMessage] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cacheWarning, setCacheWarning] = useState<string | undefined>(
    initialCacheLoad.warning,
  );
  const [recoveryState, setRecoveryState] =
    useState<ConversationRecoveryState>(
      initialConversation?.resumeToken === undefined ? "idle" : "recovering",
    );
  const activeController = useRef<AbortController | undefined>(undefined);
  const recoveryController = useRef<AbortController | undefined>(undefined);
  const recoverySequence = useRef(0);

  const replaceMessages = useCallback(
    (
      update:
        | LocalMessage[]
        | ((current: LocalMessage[]) => LocalMessage[]),
    ) => {
      const next =
        typeof update === "function" ? update(messagesRef.current) : update;
      messagesRef.current = next;
      setMessageState(next);
    },
    [],
  );

  const applyCache = useCallback((next: BrowserConversationCache) => {
    cacheRef.current = next;
    setBrowserCache(next);
    if (!cachePersistenceEnabled.current) {
      return;
    }
    const result = saveConversationCache(window.localStorage, next);
    if (!result.saved) {
      setCacheWarning(result.warning);
    }
  }, []);

  const persistConversation = useCallback(
    (
      nextSessionId: string,
      nextResumeToken: string | undefined,
      updatedAt: string,
    ) => {
      const existing = cacheRef.current.conversations.find(
        (conversation) => conversation.sessionId === nextSessionId,
      );
      const resumeToken = nextResumeToken ?? existing?.resumeToken;
      const conversation: CachedConversation = {
        sessionId: nextSessionId,
        title: existing?.title ?? titleFromMessages(messagesRef.current),
        updatedAt,
        messages: localMessagesToCache(messagesRef.current),
        ...(resumeToken === undefined ? {} : { resumeToken }),
      };
      try {
        applyCache(
          upsertCachedConversation(cacheRef.current, conversation, true),
        );
      } catch {
        setCacheWarning("Saved conversations could not be updated.");
      }
    },
    [applyCache],
  );

  const updateAssistant = useCallback(
    (id: string, update: Partial<LocalMessage>) => {
      replaceMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, ...update } : message,
        ),
      );
    },
    [replaceMessages],
  );

  const recoverConversation = useCallback(
    async (conversation: CachedConversation) => {
      if (conversation.resumeToken === undefined) {
        setRecoveryState("idle");
        return;
      }
      const sequence = recoverySequence.current + 1;
      recoverySequence.current = sequence;
      recoveryController.current?.abort();
      const controller = new AbortController();
      recoveryController.current = controller;
      setRecoveryState("recovering");
      setStatusText("Restoring conversation");
      setDisplayError(undefined);

      try {
        const response = await client.resumeSession(
          conversation.resumeToken,
          controller.signal,
        );
        if (recoverySequence.current !== sequence) {
          return;
        }
        if (response.session.id !== conversation.sessionId) {
          throw new ApiClientError(
            "The server returned an invalid resume response.",
          );
        }
        const restored = restoredMessagesToLocal(response.messages);
        replaceMessages(restored);
        setSessionId(response.session.id);
        const nextConversation: CachedConversation = {
          sessionId: response.session.id,
          resumeToken: response.resumeToken,
          title: conversation.title,
          updatedAt: response.session.updatedAt,
          messages: localMessagesToCache(restored),
        };
        applyCache(
          upsertCachedConversation(
            cacheRef.current,
            nextConversation,
            true,
          ),
        );
        setRecoveryState("idle");
        setStatusText("Ready");
      } catch (error) {
        if (
          recoverySequence.current !== sequence ||
          isAbortError(error)
        ) {
          return;
        }
        setRecoveryState("failed");
        setStatusText("Recovery failed");
      } finally {
        if (recoveryController.current === controller) {
          recoveryController.current = undefined;
        }
      }
    },
    [applyCache, client, replaceMessages],
  );

  useEffect(() => {
    if (initialConversation?.resumeToken === undefined) {
      return;
    }
    void recoverConversation(initialConversation);
    return () => {
      recoverySequence.current += 1;
      recoveryController.current?.abort();
    };
  }, [initialConversation, recoverConversation]);

  useEffect(
    () => () => {
      activeController.current?.abort();
    },
    [],
  );

  const runRequest = useCallback(
    async (message: string, includeUserMessage: boolean) => {
      const trimmedMessage = message.trim();
      if (
        trimmedMessage.length === 0 ||
        isRunning ||
        recoveryState !== "idle"
      ) {
        return;
      }

      const assistantId = makeLocalId();
      const createdAt = new Date().toISOString();
      const request: ChatRequest = {
        message: trimmedMessage,
        mode,
        ...(sessionId === undefined ? {} : { sessionId }),
      };

      const nextMessages: LocalMessage[] = [];
      if (includeUserMessage) {
        nextMessages.push({
          content: trimmedMessage,
          createdAt,
          id: makeLocalId(),
          role: "user",
        });
      }
      nextMessages.push({
        content: "",
        createdAt,
        id: assistantId,
        pending: true,
        role: "assistant",
      });

      replaceMessages((current) => [...current, ...nextMessages]);
      setDisplayError(undefined);
      setLastFailedMessage(undefined);
      setIsRunning(true);
      setStatusText("Processing request");

      const controller = new AbortController();
      activeController.current = controller;
      let streamedAnswer = "";
      let receivedTerminalEvent = false;

      try {
        for await (const event of client.streamChat(
          request,
          controller.signal,
        )) {
          switch (event.type) {
            case "turn.started":
              setStatusText("Processing request");
              break;
            case "status.changed":
              setStatusText(event.status);
              break;
            case "assistant.delta":
              streamedAnswer += event.text;
              updateAssistant(assistantId, { content: streamedAnswer });
              break;
            case "source.added":
              replaceMessages((current) =>
                current.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        sources: [...(item.sources ?? []), event.source],
                      }
                    : item,
                ),
              );
              break;
            case "turn.completed":
              receivedTerminalEvent = true;
              setSessionId(event.result.sessionId);
              setStatusText("Ready");
              updateAssistant(assistantId, {
                content: event.result.answer,
                followUpGuidance: event.result.followUpGuidance,
                followUpQuestion: event.result.followUpQuestion,
                pending: false,
                sources: event.result.sources,
                status: event.result.status,
              });
              persistConversation(
                event.result.sessionId,
                event.result.resumeToken,
                new Date().toISOString(),
              );
              break;
            case "turn.failed":
              receivedTerminalEvent = true;
              throw toApiClientError(event.error);
          }
        }

        if (!receivedTerminalEvent) {
          throw new ApiClientError(
            "The response stream ended before the turn completed.",
          );
        }
      } catch (error) {
        if (activeController.current !== controller) {
          return;
        }

        if (isAbortError(error)) {
          setStatusText("Stopped");
          updateAssistant(assistantId, {
            content: streamedAnswer,
            pending: false,
            status: streamedAnswer.length > 0 ? "PARTIAL" : "ERROR",
          });
          if (sessionId !== undefined) {
            persistConversation(
              sessionId,
              undefined,
              new Date().toISOString(),
            );
          }
        } else {
          const nextError = toDisplayError(error);
          setDisplayError(nextError);
          setLastFailedMessage(trimmedMessage);
          setStatusText("Request failed");
          updateAssistant(assistantId, {
            content: streamedAnswer,
            pending: false,
            status: streamedAnswer.length > 0 ? "PARTIAL" : "ERROR",
          });
          if (
            error instanceof ApiClientError &&
            error.publicError?.code === "SESSION_NOT_FOUND" &&
            sessionId !== undefined
          ) {
            setRecoveryState("failed");
          }
        }
      } finally {
        if (activeController.current === controller) {
          activeController.current = undefined;
          setIsRunning(false);
        }
      }
    },
    [
      client,
      isRunning,
      mode,
      persistConversation,
      recoveryState,
      replaceMessages,
      sessionId,
      updateAssistant,
    ],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft;
    setDraft("");
    void runRequest(message, true);
  };

  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleStop = () => {
    activeController.current?.abort();
  };

  const handleNewConversation = () => {
    if (isRunning || recoveryState === "recovering") {
      return;
    }
    recoverySequence.current += 1;
    recoveryController.current?.abort();
    recoveryController.current = undefined;
    replaceMessages([]);
    setSessionId(undefined);
    setDraft("");
    setDisplayError(undefined);
    setLastFailedMessage(undefined);
    setRecoveryState("idle");
    setStatusText("Ready");
    setDrawerOpen(false);
    try {
      applyCache(activateCachedConversation(cacheRef.current, undefined));
    } catch {
      setCacheWarning("Saved conversations could not be updated.");
    }
  };

  const handleRetryRequest = () => {
    if (lastFailedMessage !== undefined) {
      void runRequest(lastFailedMessage, false);
    }
  };

  const handleSelectConversation = (selectedSessionId: string) => {
    if (isRunning || recoveryState === "recovering") {
      return;
    }
    const conversation = cacheRef.current.conversations.find(
      (item) => item.sessionId === selectedSessionId,
    );
    if (conversation === undefined) {
      return;
    }
    replaceMessages(cachedMessagesToLocal(conversation.messages));
    setSessionId(conversation.sessionId);
    setDisplayError(undefined);
    setLastFailedMessage(undefined);
    setDrawerOpen(false);
    setRecoveryState(
      conversation.resumeToken === undefined ? "idle" : "recovering",
    );
    try {
      applyCache(
        activateCachedConversation(cacheRef.current, conversation.sessionId),
      );
    } catch {
      setCacheWarning("Saved conversations could not be updated.");
    }
    if (conversation.resumeToken !== undefined) {
      void recoverConversation(conversation);
    } else {
      setStatusText("Ready");
    }
  };

  const handleRetryRecovery = () => {
    const conversation = cacheRef.current.conversations.find(
      (item) => item.sessionId === sessionId,
    );
    if (conversation?.resumeToken !== undefined) {
      void recoverConversation(conversation);
    }
  };

  const composerDisabled = isRunning || recoveryState !== "idle";
  const canRetryRecovery = browserCache.conversations.some(
    (conversation) =>
      conversation.sessionId === sessionId &&
      conversation.resumeToken !== undefined,
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Public API demo</p>
          <h1>Skein Chatbot</h1>
        </div>
        <button
          aria-controls="conversation-sidebar"
          aria-expanded={drawerOpen}
          className="sidebar-toggle-button"
          onClick={() => setDrawerOpen((current) => !current)}
          type="button"
        >
          Conversation history
        </button>
      </header>

      {cacheWarning === undefined ? null : (
        <div className="cache-warning" role="alert">
          <strong>Local history warning</strong>
          <p>{cacheWarning}</p>
        </div>
      )}

      <button
        aria-label="Dismiss conversation history"
        className={drawerOpen ? "drawer-backdrop is-open" : "drawer-backdrop"}
        onClick={() => setDrawerOpen(false)}
        type="button"
      />

      <div className="workspace-shell">
        <ConversationSidebar
          canRetryRecovery={canRetryRecovery}
          conversations={browserCache.conversations}
          drawerOpen={drawerOpen}
          isRunning={isRunning}
          onClose={() => setDrawerOpen(false)}
          onNewConversation={handleNewConversation}
          onRetryRecovery={handleRetryRecovery}
          onSelectConversation={handleSelectConversation}
          recoveryState={recoveryState}
          {...(sessionId === undefined ? {} : { activeSessionId: sessionId })}
        />

        <main className="chat-panel">
          <section
            aria-label="Conversation"
            aria-live="polite"
            className="conversation"
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="empty-mark" aria-hidden="true">
                  S
                </span>
                <h2>Start a test conversation</h2>
                <p>
                  This replaceable client talks only to the stable Skein REST
                  and event-stream endpoints.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageCard key={message.id} message={message} />
              ))
            )}
          </section>

          <section className="composer-section" aria-label="Message composer">
            {displayError === undefined ? null : (
              <div className="error-panel" role="alert">
                <div>
                  <strong>Request failed</strong>
                  <p>{displayError.message}</p>
                  {displayError.traceId === undefined ? null : (
                    <small>Trace: {displayError.traceId}</small>
                  )}
                </div>
                {displayError.retryable && lastFailedMessage !== undefined ? (
                  <button
                    className="retry-button"
                    disabled={composerDisabled}
                    onClick={handleRetryRequest}
                    type="button"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            )}

            <form className="composer" onSubmit={handleSubmit}>
              <div className="composer-toolbar">
                <fieldset disabled={composerDisabled}>
                  <legend className="sr-only">Response mode</legend>
                  <label className={mode === "quick" ? "active" : ""}>
                    <input
                      checked={mode === "quick"}
                      name="mode"
                      onChange={() => setMode("quick")}
                      type="radio"
                      value="quick"
                    />
                    Quick
                  </label>
                  <label className={mode === "deep" ? "active" : ""}>
                    <input
                      checked={mode === "deep"}
                      name="mode"
                      onChange={() => setMode("deep")}
                      type="radio"
                      value="deep"
                    />
                    Deep
                  </label>
                </fieldset>
                <span className="runtime-status">
                  <span
                    aria-hidden="true"
                    className={isRunning ? "status-dot active" : "status-dot"}
                  />
                  {statusText}
                </span>
              </div>

              <textarea
                aria-label="Message"
                disabled={composerDisabled}
                maxLength={32_000}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask a question…"
                rows={3}
                value={draft}
              />

              <div className="composer-actions">
                <span>Enter to send · Shift+Enter for a new line</span>
                {isRunning ? (
                  <button
                    className="stop-button"
                    onClick={handleStop}
                    type="button"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="send-button"
                    disabled={
                      composerDisabled || draft.trim().length === 0
                    }
                    type="submit"
                  >
                    Send
                  </button>
                )}
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}

function MessageCard({ message }: { message: LocalMessage }) {
  const hasSources = (message.sources?.length ?? 0) > 0;
  const hasFollowUp =
    (message.followUpQuestion?.length ?? 0) > 0 ||
    (message.followUpGuidance?.length ?? 0) > 0;

  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">
        {message.role === "user" ? "You" : "Assistant"}
        {message.status === undefined ? null : (
          <span className={`status-badge status-${message.status.toLowerCase()}`}>
            {message.status.replace("_", " ")}
          </span>
        )}
      </div>
      <div className="message-body">
        {message.content.length > 0 ? (
          message.role === "assistant" ? (
            <MarkdownMessage content={message.content} />
          ) : (
            <p>{message.content}</p>
          )
        ) : message.pending ? (
          <span className="typing" aria-label="Waiting for response">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <p className="muted">No response content.</p>
        )}
      </div>

      {hasSources ? <SourceList sources={message.sources ?? []} /> : null}

      {hasFollowUp ? (
        <aside className="follow-up">
          <strong>Follow-up</strong>
          {message.followUpQuestion ? <p>{message.followUpQuestion}</p> : null}
          {message.followUpGuidance ? (
            <small>{message.followUpGuidance}</small>
          ) : null}
        </aside>
      ) : null}
    </article>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <aside className="sources">
      <strong>Sources</strong>
      <ol>
        {sources.map((source, index) => (
          <li key={source.id ?? `${source.title}-${index}`}>
            {source.url === undefined ? (
              source.title
            ) : (
              <a href={source.url} rel="noopener noreferrer" target="_blank">
                {source.title}
              </a>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

const toApiClientError = (error: PublicError): ApiClientError =>
  new ApiClientError(error.message, { publicError: error });
