import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CachedConversation } from "./conversation-cache.js";
import { ConversationSidebar } from "./conversation-sidebar.js";

const conversation = (
  sessionId: string,
  title: string,
  updatedAt: string,
): CachedConversation => ({
  sessionId,
  resumeToken: `token-${sessionId}`,
  title,
  updatedAt,
  messages: [],
});

const renderSidebar = (
  overrides: Partial<Parameters<typeof ConversationSidebar>[0]> = {},
): string =>
  renderToStaticMarkup(
    createElement(ConversationSidebar, {
      conversations: [
        conversation(
          "session-older",
          "Older conversation",
          "2026-08-25T00:00:00.000Z",
        ),
        conversation(
          "session-newer",
          "Newer conversation",
          "2026-08-25T00:00:02.000Z",
        ),
      ],
      activeSessionId: "session-newer",
      drawerOpen: false,
      isRunning: false,
      canRetryRecovery: true,
      recoveryState: "idle",
      onClose: vi.fn(),
      onNewConversation: vi.fn(),
      onRetryRecovery: vi.fn(),
      onSelectConversation: vi.fn(),
      ...overrides,
    }),
  );

describe("ConversationSidebar", () => {
  it("removes the closed mobile drawer and backdrop from keyboard focus", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.conversation-sidebar\s*\{[\s\S]*?visibility:\s*hidden;/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.conversation-sidebar\.is-open\s*\{[\s\S]*?visibility:\s*visible;/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.drawer-backdrop\s*\{[\s\S]*?visibility:\s*hidden;/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.drawer-backdrop\.is-open\s*\{[\s\S]*?visibility:\s*visible;/u,
    );
  });

  it("renders labelled navigation, New Conversation, and newest-first session buttons", () => {
    const html = renderSidebar();

    expect(html).toContain('<nav aria-label="Conversation history"');
    expect(html).toContain("New conversation");
    expect(html.indexOf("Newer conversation")).toBeLessThan(
      html.indexOf("Older conversation"),
    );
  });

  it("marks the active session and exposes the mobile drawer relationship", () => {
    const html = renderSidebar({ drawerOpen: true });

    expect(html).toContain('id="conversation-sidebar"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Close conversation history"');
    expect(html).toContain("conversation-sidebar is-open");
  });

  it("renders untrusted long titles as truncated plain text", () => {
    const title = `<strong>${"Long title ".repeat(12)}</strong>`;
    const html = renderSidebar({
      conversations: [
        conversation("session-title", title, "2026-08-25T00:00:00.000Z"),
      ],
      activeSessionId: "session-title",
    });

    expect(html).not.toContain("<strong>");
    expect(html).toContain("&lt;strong&gt;");
    expect(html).toContain("…");
    expect(html).not.toContain(title);
  });

  it("announces recovery progress and offers retry for read-only failures", () => {
    const recovering = renderSidebar({ recoveryState: "recovering" });
    expect(recovering).toContain('role="status"');
    expect(recovering).toContain("Restoring conversation…");

    const failed = renderSidebar({ recoveryState: "failed" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Cached messages are read-only.");
    expect(failed).toContain("Retry recovery");
  });

  it("does not offer a recovery retry when no opaque token is available", () => {
    const html = renderSidebar({
      canRetryRecovery: false,
      recoveryState: "failed",
    });

    expect(html).toContain("Cached messages are read-only.");
    expect(html).not.toContain("Retry recovery");
  });

  it("disables conversation switching and creation while a turn is active", () => {
    const html = renderSidebar({ isRunning: true });

    expect(html.match(/disabled=""/gu)).toHaveLength(4);
  });
});
