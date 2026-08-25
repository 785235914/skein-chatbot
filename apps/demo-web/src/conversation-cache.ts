import { z } from "zod";

export const CONVERSATION_CACHE_KEY = "skein.chat.history.v1";

const CACHE_LOAD_WARNING = "Saved conversations could not be loaded.";
const CACHE_SAVE_WARNING = "Saved conversations could not be updated.";
const MAXIMUM_CACHE_CHARACTERS = 8 * 1024 * 1024;
const MAXIMUM_CONVERSATIONS = 500;
const MAXIMUM_MESSAGES_PER_CONVERSATION = 400;
const MAXIMUM_MESSAGE_CONTENT_CHARACTERS = 1_000_000;

const CachedMessageSchema = z
  .object({
    id: z.string().min(1).max(512),
    role: z.enum(["USER", "ASSISTANT"]),
    content: z.string().max(MAXIMUM_MESSAGE_CONTENT_CHARACTERS),
    createdAt: z.string().datetime(),
  })
  .strict();

const CachedConversationSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    resumeToken: z.string().min(1).max(8_192).optional(),
    title: z.string().min(1).max(160),
    updatedAt: z.string().datetime(),
    messages: z
      .array(CachedMessageSchema)
      .max(MAXIMUM_MESSAGES_PER_CONVERSATION),
  })
  .strict()
  .superRefine((conversation, context) => {
    const ids = new Set<string>();
    for (const [index, message] of conversation.messages.entries()) {
      if (ids.has(message.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Cached message IDs must be unique.",
          path: ["messages", index, "id"],
        });
      }
      ids.add(message.id);
    }
  });

const BrowserConversationCacheSchema = z
  .object({
    version: z.literal(1),
    activeSessionId: z.string().min(1).max(128).optional(),
    conversations: z
      .array(CachedConversationSchema)
      .max(MAXIMUM_CONVERSATIONS),
  })
  .strict()
  .superRefine((cache, context) => {
    const sessionIds = new Set<string>();
    for (const [index, conversation] of cache.conversations.entries()) {
      if (sessionIds.has(conversation.sessionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Cached session IDs must be unique.",
          path: ["conversations", index, "sessionId"],
        });
      }
      sessionIds.add(conversation.sessionId);
    }
    if (
      cache.activeSessionId !== undefined &&
      !sessionIds.has(cache.activeSessionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The active cached session must exist.",
        path: ["activeSessionId"],
      });
    }
  });

export type CachedMessage = z.infer<typeof CachedMessageSchema>;
export type CachedConversation = z.infer<typeof CachedConversationSchema>;
export type BrowserConversationCache = z.infer<
  typeof BrowserConversationCacheSchema
>;

export type ConversationCacheLoadResult = {
  cache: BrowserConversationCache;
  warning?: string;
};

export type ConversationCacheSaveResult =
  | { saved: true }
  | { saved: false; warning: string };

const emptyCache = (): BrowserConversationCache => ({
  version: 1,
  conversations: [],
});

export const loadConversationCache = (
  storage: Pick<Storage, "getItem">,
): ConversationCacheLoadResult => {
  let persisted: string | null;
  try {
    persisted = storage.getItem(CONVERSATION_CACHE_KEY);
  } catch {
    return { cache: emptyCache(), warning: CACHE_LOAD_WARNING };
  }
  if (persisted === null) {
    return { cache: emptyCache() };
  }
  if (persisted.length > MAXIMUM_CACHE_CHARACTERS) {
    return { cache: emptyCache(), warning: CACHE_LOAD_WARNING };
  }

  try {
    const parsed = BrowserConversationCacheSchema.safeParse(
      JSON.parse(persisted) as unknown,
    );
    if (!parsed.success) {
      return { cache: emptyCache(), warning: CACHE_LOAD_WARNING };
    }
    return { cache: parsed.data };
  } catch {
    return { cache: emptyCache(), warning: CACHE_LOAD_WARNING };
  }
};

export const saveConversationCache = (
  storage: Pick<Storage, "setItem">,
  cache: BrowserConversationCache,
): ConversationCacheSaveResult => {
  const parsed = BrowserConversationCacheSchema.safeParse(cache);
  if (!parsed.success) {
    return { saved: false, warning: CACHE_SAVE_WARNING };
  }
  try {
    const serialized = JSON.stringify(parsed.data);
    if (serialized.length > MAXIMUM_CACHE_CHARACTERS) {
      return { saved: false, warning: CACHE_SAVE_WARNING };
    }
    storage.setItem(CONVERSATION_CACHE_KEY, serialized);
    return { saved: true };
  } catch {
    return { saved: false, warning: CACHE_SAVE_WARNING };
  }
};

export const upsertCachedConversation = (
  cache: BrowserConversationCache,
  conversation: CachedConversation,
  activate: boolean,
): BrowserConversationCache => {
  const parsedCache = BrowserConversationCacheSchema.parse(cache);
  const parsedConversation = CachedConversationSchema.parse(conversation);
  const existingIndex = parsedCache.conversations.findIndex(
    (item) => item.sessionId === parsedConversation.sessionId,
  );
  const conversations = [...parsedCache.conversations];
  if (existingIndex === -1) {
    conversations.push(parsedConversation);
  } else {
    conversations[existingIndex] = parsedConversation;
  }
  const originalPositions = new Map(
    conversations.map((item, index) => [item.sessionId, index]),
  );
  conversations.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      (originalPositions.get(left.sessionId) ?? 0) -
        (originalPositions.get(right.sessionId) ?? 0),
  );

  return BrowserConversationCacheSchema.parse({
    ...parsedCache,
    conversations,
    ...(activate
      ? { activeSessionId: parsedConversation.sessionId }
      : {}),
  });
};

export const activateCachedConversation = (
  cache: BrowserConversationCache,
  sessionId: string | undefined,
): BrowserConversationCache => {
  const parsed = BrowserConversationCacheSchema.parse(cache);
  if (
    sessionId !== undefined &&
    !parsed.conversations.some(
      (conversation) => conversation.sessionId === sessionId,
    )
  ) {
    throw new Error("The cached conversation does not exist.");
  }
  const { activeSessionId: _activeSessionId, ...withoutActive } = parsed;
  return BrowserConversationCacheSchema.parse({
    ...withoutActive,
    ...(sessionId === undefined ? {} : { activeSessionId: sessionId }),
  });
};
