import { z } from "zod";

import {
  RuntimeError,
  RuntimeErrorCode,
  type ConversationHistoryEntry,
  type ConversationHistorySource,
} from "@skein-chatbot/core";

import {
  createDifyInvalidResponseError,
  mapDifyHttpError,
  mapDifyTransportError,
} from "./errors.js";
import type {
  DifyConversationHistoryOptions,
  DifyFetch,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 100;
const MAXIMUM_HISTORY_ENTRIES = 200;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_USER_LENGTH = 255;
const MAXIMUM_UNIX_SECONDS = 8_640_000_000_000;

const DifyMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversation_id: z.string().min(1).max(2_048),
    query: z.string(),
    answer: z.string(),
    created_at: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_UNIX_SECONDS)
      .finite(),
  })
  .passthrough();

const DifyMessagePageSchema = z
  .object({
    data: z.array(DifyMessageSchema).max(MAXIMUM_PAGE_SIZE),
    has_more: z.boolean(),
    limit: z.number().int().min(1).max(MAXIMUM_PAGE_SIZE).optional(),
  })
  .passthrough();

const normalizeBaseUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The provider base URL is invalid.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The provider base URL is invalid.",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
};

const readBoundedText = async (
  response: Response,
  maximumBytes: number,
): Promise<{ bytes: number; text: string }> => {
  if (response.body === null) {
    return { bytes: 0, text: "" };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        try {
          text += decoder.decode();
        } catch {
          throw createDifyInvalidResponseError();
        }
        return { bytes, text };
      }
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        throw createDifyInvalidResponseError();
      }
      try {
        text += decoder.decode(next.value, { stream: true });
      } catch {
        throw createDifyInvalidResponseError();
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
};

const assertJsonResponse = (response: Response): void => {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== "application/json" &&
    mediaType?.endsWith("+json") !== true
  ) {
    throw createDifyInvalidResponseError();
  }
};

const parsePage = (text: string): z.infer<typeof DifyMessagePageSchema> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw createDifyInvalidResponseError();
  }
  const parsed = DifyMessagePageSchema.safeParse(value);
  if (!parsed.success) {
    throw createDifyInvalidResponseError();
  }
  return parsed.data;
};

interface TimestampedHistoryEntry extends ConversationHistoryEntry {
  readonly timestamp: number;
}

export class DifyConversationHistorySource
  implements ConversationHistorySource
{
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: DifyFetch;
  private readonly pageSize: number;
  private readonly maximumResponseBytes: number;

  constructor(options: DifyConversationHistoryOptions) {
    this.endpoint = `${normalizeBaseUrl(options.baseUrl)}/messages`;
    if (options.apiKey.trim().length === 0) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The provider app key is required.",
      );
    }
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maximumResponseBytes =
      options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAXIMUM_PAGE_SIZE ||
      !Number.isInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The provider history limits are invalid.",
      );
    }
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.pageSize = pageSize;
    this.maximumResponseBytes = maximumResponseBytes;
  }

  async loadHistory(
    input: {
      externalConversationId: string;
      userId: string;
      maximumEntries: number;
    },
    signal?: AbortSignal,
  ): Promise<readonly ConversationHistoryEntry[]> {
    if (
      input.externalConversationId.length === 0 ||
      input.externalConversationId.length > 2_048 ||
      input.userId.length === 0 ||
      input.userId.length > MAXIMUM_USER_LENGTH ||
      !Number.isInteger(input.maximumEntries) ||
      input.maximumEntries < 1
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The provider history request is invalid.",
      );
    }

    const maximumEntries = Math.min(
      input.maximumEntries,
      MAXIMUM_HISTORY_ENTRIES,
    );
    const entries: TimestampedHistoryEntry[] = [];
    const messageIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let responseBytes = 0;

    while (entries.length < maximumEntries) {
      if (signal?.aborted === true) {
        throw mapDifyTransportError(signal.reason, signal);
      }
      const requestedLimit = Math.min(
        this.pageSize,
        maximumEntries - entries.length,
      );
      const url = new URL(this.endpoint);
      url.searchParams.set(
        "conversation_id",
        input.externalConversationId,
      );
      url.searchParams.set("user", input.userId);
      url.searchParams.set("limit", String(requestedLimit));
      if (cursor !== undefined) {
        url.searchParams.set("first_id", cursor);
      }

      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          redirect: "error",
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw mapDifyTransportError(error, signal);
      }
      if (!response.ok) {
        throw mapDifyHttpError(response.status);
      }
      assertJsonResponse(response);

      const remainingBytes = this.maximumResponseBytes - responseBytes;
      if (remainingBytes < 1) {
        throw createDifyInvalidResponseError();
      }
      const result = await readBoundedText(response, remainingBytes).catch(
        (error: unknown) => {
          throw mapDifyTransportError(error, signal);
        },
      );
      responseBytes += result.bytes;
      const page = parsePage(result.text);
      if (page.data.length > requestedLimit) {
        throw createDifyInvalidResponseError();
      }

      for (const providerMessage of page.data) {
        if (
          providerMessage.conversation_id !== input.externalConversationId ||
          messageIds.has(providerMessage.id)
        ) {
          throw createDifyInvalidResponseError();
        }
        messageIds.add(providerMessage.id);
        entries.push({
          id: providerMessage.id,
          userContent: providerMessage.query,
          assistantContent: providerMessage.answer,
          createdAt: new Date(providerMessage.created_at * 1_000).toISOString(),
          timestamp: providerMessage.created_at,
        });
      }

      if (!page.has_more || entries.length >= maximumEntries) {
        break;
      }
      const nextCursor = page.data[0]?.id;
      if (nextCursor === undefined || cursors.has(nextCursor)) {
        throw createDifyInvalidResponseError();
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }

    return entries
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.id.localeCompare(right.id),
      )
      .map(({ timestamp: _timestamp, ...entry }) => entry);
  }
}

export const createDifyConversationHistorySource = (
  options: DifyConversationHistoryOptions,
): DifyConversationHistorySource => new DifyConversationHistorySource(options);
