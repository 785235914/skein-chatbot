import { useState } from "react";
import type { CachedConversation } from "./conversation-cache.js";

export type ConversationRecoveryState = "idle" | "recovering" | "failed";

export interface ConversationSidebarProps {
  conversations: readonly CachedConversation[];
  activeSessionId?: string;
  canRetryRecovery: boolean;
  drawerOpen: boolean;
  isRunning: boolean;
  recoveryState: ConversationRecoveryState;
  onClose(): void;
  onNewConversation(): void;
  onRetryRecovery(): void;
  onSelectConversation(sessionId: string): void;
}

const MAXIMUM_VISIBLE_TITLE_CHARACTERS = 72;

const visibleTitle = (title: string): string => {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= MAXIMUM_VISIBLE_TITLE_CHARACTERS) {
    return normalized;
  }
  return `${characters.slice(0, MAXIMUM_VISIBLE_TITLE_CHARACTERS - 1).join("")}…`;
};

export function ConversationSidebar({
  conversations,
  activeSessionId,
  canRetryRecovery,
  drawerOpen,
  isRunning,
  recoveryState,
  onClose,
  onNewConversation,
  onRetryRecovery,
  onSelectConversation,
}: ConversationSidebarProps) {
  const switchingDisabled = isRunning;
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const newestFirst = conversations
    .filter((conversation) =>
      `${conversation.title} ${conversation.sessionId}`.toLocaleLowerCase().includes(query),
    )
    .map((conversation, index) => ({ conversation, index }))
    .sort(
      (left, right) =>
        Date.parse(right.conversation.updatedAt) -
          Date.parse(left.conversation.updatedAt) ||
        left.index - right.index,
    )
    .map(({ conversation }) => conversation);

  return (
    <aside
      className={`conversation-sidebar${drawerOpen ? " is-open" : ""}`}
      id="conversation-sidebar"
    >
      <div className="sidebar-heading">
        <div>
          <p className="eyebrow">Local browser history</p>
          <h2>Conversations</h2>
        </div>
        <button
          aria-label="Close conversation history"
          className="sidebar-close-button"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <nav aria-label="Conversation history">
        <input
          aria-label="Search conversations"
          type="search"
          placeholder="Search conversations"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="history-search"
        />
        <button
          className="new-conversation-button"
          disabled={switchingDisabled}
          onClick={onNewConversation}
          type="button"
        >
          <span aria-hidden="true">+</span>
          New conversation
        </button>

        {newestFirst.length === 0 ? (
          <p className="sidebar-empty">
            {conversations.length === 0 ? "No saved conversations yet." : "No matching conversations."}
          </p>
        ) : (
          <ol className="conversation-list">
            {newestFirst.map((conversation) => {
              const active = conversation.sessionId === activeSessionId;
              return (
                <li key={conversation.sessionId}>
                  <button
                    {...(active ? { "aria-current": "page" as const } : {})}
                    className={active ? "conversation-button active" : "conversation-button"}
                    disabled={switchingDisabled}
                    onClick={() => onSelectConversation(conversation.sessionId)}
                    type="button"
                  >
                    <span className="conversation-title">
                      {visibleTitle(conversation.title)}
                    </span>
                    <time dateTime={conversation.updatedAt}>
                      {new Date(conversation.updatedAt).toLocaleDateString()}
                    </time>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </nav>

      {canRetryRecovery && recoveryState === "idle" ? (
        <button className="retry-button" disabled={isRunning} onClick={onRetryRecovery} type="button">
          Refresh history
        </button>
      ) : null}

      {recoveryState === "recovering" ? (
        <p className="recovery-notice" role="status">
          Restoring conversation…
        </p>
      ) : null}
      {recoveryState === "failed" ? (
        <div className="recovery-notice recovery-failed" role="alert">
          <p>Recovery failed. Cached messages are read-only.</p>
          {canRetryRecovery ? (
            <button
              className="retry-button"
              disabled={isRunning}
              onClick={onRetryRecovery}
              type="button"
            >
              Retry recovery
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
