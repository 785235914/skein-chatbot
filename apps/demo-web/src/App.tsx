import { useCallback, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type {
  ChatMode,
  ChatRequest,
  ChatStatus,
  PublicError,
  Source,
} from "@skein-chatbot/contracts";

import { ApiClientError, createApiClient } from "./api.js";
import { MarkdownMessage } from "./message-markdown.js";

type LocalRole = "assistant" | "user";

interface LocalMessage {
  id: string;
  role: LocalRole;
  content: string;
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
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [mode, setMode] = useState<ChatMode>("quick");
  const [draft, setDraft] = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const [displayError, setDisplayError] = useState<DisplayError>();
  const [lastFailedMessage, setLastFailedMessage] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const activeController = useRef<AbortController | undefined>(undefined);

  const updateAssistant = useCallback(
    (id: string, update: Partial<LocalMessage>) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, ...update } : message,
        ),
      );
    },
    [],
  );

  const runRequest = useCallback(
    async (message: string, includeUserMessage: boolean) => {
      const trimmedMessage = message.trim();
      if (trimmedMessage.length === 0 || isRunning) {
        return;
      }

      const assistantId = makeLocalId();
      const request: ChatRequest = {
        message: trimmedMessage,
        mode,
        ...(sessionId === undefined ? {} : { sessionId }),
      };

      const nextMessages: LocalMessage[] = [];
      if (includeUserMessage) {
        nextMessages.push({
          content: trimmedMessage,
          id: makeLocalId(),
          role: "user",
        });
      }
      nextMessages.push({
        content: "",
        id: assistantId,
        pending: true,
        role: "assistant",
      });

      setMessages((current) => [...current, ...nextMessages]);
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
              setMessages((current) =>
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
        }
      } finally {
        if (activeController.current === controller) {
          activeController.current = undefined;
          setIsRunning(false);
        }
      }
    },
    [client, isRunning, mode, sessionId, updateAssistant],
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
    const controller = activeController.current;
    activeController.current = undefined;
    controller?.abort();
    setIsRunning(false);
    setMessages([]);
    setSessionId(undefined);
    setDisplayError(undefined);
    setLastFailedMessage(undefined);
    setStatusText("Ready");
  };

  const handleRetry = () => {
    if (lastFailedMessage !== undefined) {
      void runRequest(lastFailedMessage, false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Public API demo</p>
          <h1>Skein Chatbot</h1>
        </div>
        <button
          className="secondary-button"
          disabled={messages.length === 0 && sessionId === undefined}
          onClick={handleNewConversation}
          type="button"
        >
          New conversation
        </button>
      </header>

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
                This replaceable client talks only to the stable Skein REST and
                event-stream endpoints.
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
                  disabled={isRunning}
                  onClick={handleRetry}
                  type="button"
                >
                  Retry
                </button>
              ) : null}
            </div>
          )}

          <form className="composer" onSubmit={handleSubmit}>
            <div className="composer-toolbar">
              <fieldset disabled={isRunning}>
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
              disabled={isRunning}
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
                  disabled={draft.trim().length === 0}
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
              <a href={source.url} rel="noreferrer" target="_blank">
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
