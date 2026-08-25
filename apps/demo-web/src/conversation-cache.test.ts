import { describe, expect, it } from "vitest";

import {
  CONVERSATION_CACHE_KEY,
  activateCachedConversation,
  loadConversationCache,
  saveConversationCache,
  upsertCachedConversation,
  type BrowserConversationCache,
  type CachedConversation,
} from "./conversation-cache.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  throwOnWrite = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite) {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

const message = (id = "message-1") => ({
  id,
  role: "USER" as const,
  content: "Cached question",
  createdAt: "2026-08-25T00:00:00.000Z",
});

const conversation = (
  overrides: Partial<CachedConversation> = {},
): CachedConversation => ({
  sessionId: "session-1",
  resumeToken: "opaque-token",
  title: "Cached question",
  updatedAt: "2026-08-25T00:00:01.000Z",
  messages: [message()],
  ...overrides,
});

const cache = (
  overrides: Partial<BrowserConversationCache> = {},
): BrowserConversationCache => ({
  version: 1,
  conversations: [conversation()],
  ...overrides,
});

describe("browser conversation cache", () => {
  it("returns an empty versioned cache when storage has no document", () => {
    const storage = new MemoryStorage();

    expect(loadConversationCache(storage)).toEqual({
      cache: { version: 1, conversations: [] },
    });
  });

  it("round-trips a valid cache without touching unrelated keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("unrelated", "preserve-me");
    const expected = cache({ activeSessionId: "session-1" });

    expect(saveConversationCache(storage, expected)).toEqual({ saved: true });
    expect(loadConversationCache(storage)).toEqual({ cache: expected });
    expect(storage.getItem("unrelated")).toBe("preserve-me");
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["unknown version", JSON.stringify({ version: 2, conversations: [] })],
  ])("ignores %s without rewriting or deleting it", (_label, persisted) => {
    const storage = new MemoryStorage();
    storage.setItem(CONVERSATION_CACHE_KEY, persisted);

    const result = loadConversationCache(storage);

    expect(result.cache).toEqual({ version: 1, conversations: [] });
    expect(result.warning).toBe("Saved conversations could not be loaded.");
    expect(storage.getItem(CONVERSATION_CACHE_KEY)).toBe(persisted);
  });

  it.each([
    ["title", cache({ conversations: [conversation({ title: "t".repeat(161) })] })],
    [
      "token",
      cache({
        conversations: [conversation({ resumeToken: "t".repeat(8_193) })],
      }),
    ],
    [
      "message count",
      cache({
        conversations: [
          conversation({
            messages: Array.from({ length: 401 }, (_, index) =>
              message(`message-${index}`),
            ),
          }),
        ],
      }),
    ],
    [
      "message content",
      cache({
        conversations: [
          conversation({
            messages: [
              { ...message(), content: "c".repeat(1_000_001) },
            ],
          }),
        ],
      }),
    ],
  ])("rejects oversized %s from untrusted storage", (_label, value) => {
    const storage = new MemoryStorage();
    const persisted = JSON.stringify(value);
    storage.setItem(CONVERSATION_CACHE_KEY, persisted);

    const result = loadConversationCache(storage);

    expect(result.warning).toBe("Saved conversations could not be loaded.");
    expect(result.cache.conversations).toEqual([]);
    expect(storage.getItem(CONVERSATION_CACHE_KEY)).toBe(persisted);
  });

  it("preserves UI and persisted state when a storage write fails", () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify(cache());
    storage.setItem(CONVERSATION_CACHE_KEY, original);
    storage.throwOnWrite = true;

    expect(
      saveConversationCache(storage, cache({ activeSessionId: "session-1" })),
    ).toEqual({
      saved: false,
      warning: "Saved conversations could not be updated.",
    });
    expect(storage.getItem(CONVERSATION_CACHE_KEY)).toBe(original);
  });

  it("upserts newest first with stable ordering and can activate the session", () => {
    const original = cache({
      activeSessionId: "session-1",
      conversations: [
        conversation({ sessionId: "session-1", title: "First" }),
        conversation({ sessionId: "session-2", title: "Second" }),
      ],
    });
    const updated = upsertCachedConversation(
      original,
      conversation({
        sessionId: "session-2",
        title: "Updated second",
        updatedAt: "2026-08-25T00:00:02.000Z",
      }),
      true,
    );

    expect(updated.activeSessionId).toBe("session-2");
    expect(updated.conversations.map((item) => item.title)).toEqual([
      "Updated second",
      "First",
    ]);
    expect(original.conversations.map((item) => item.title)).toEqual([
      "First",
      "Second",
    ]);

    const equalTimes = cache({
      conversations: [
        conversation({ sessionId: "session-1", title: "First" }),
        conversation({ sessionId: "session-2", title: "Second" }),
      ],
    });
    expect(
      upsertCachedConversation(
        equalTimes,
        conversation({ sessionId: "session-3", title: "Third" }),
        false,
      ).conversations.map((item) => item.title),
    ).toEqual(["First", "Second", "Third"]);
  });

  it("updates only the active selection and validates the target", () => {
    const original = cache({ activeSessionId: "session-1" });

    expect(activateCachedConversation(original, undefined)).toEqual({
      version: 1,
      conversations: original.conversations,
    });
    expect(() =>
      activateCachedConversation(original, "missing-session"),
    ).toThrow("The cached conversation does not exist.");
  });
});
