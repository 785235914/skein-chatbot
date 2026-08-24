import {
  ChatResponseSchema,
  PublicErrorSchema,
  RuntimeEventSchema,
} from "@skein-chatbot/contracts";
import type {
  ChatRequest,
  ChatResponse,
  PublicError,
  RuntimeEvent,
} from "@skein-chatbot/contracts";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
} as const;

const STREAM_HEADERS = {
  Accept: "text/event-stream",
  "Content-Type": "application/json",
} as const;

const eventBoundary = /\r\n\r\n|\n\n|\r\r/;

export class ApiClientError extends Error {
  readonly publicError: PublicError | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { cause?: unknown; publicError?: PublicError; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiClientError";
    this.publicError = options.publicError;
    this.status = options.status;
  }
}

/**
 * Incrementally parses SSE frames. Only the canonical RuntimeEvent payload in
 * each `data` field is returned; transport-only SSE fields remain private.
 */
export class RuntimeEventStreamParser {
  private buffer = "";

  push(chunk: string): RuntimeEvent[] {
    this.buffer += chunk;
    return this.drainCompleteBlocks();
  }

  finish(): RuntimeEvent[] {
    const events = this.drainCompleteBlocks();
    const trailingBlock = this.buffer.trim();
    this.buffer = "";

    if (trailingBlock.length > 0) {
      const event = parseRuntimeEventBlock(trailingBlock);
      if (event !== undefined) {
        events.push(event);
      }
    }

    return events;
  }

  private drainCompleteBlocks(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    let boundary = eventBoundary.exec(this.buffer);

    while (boundary !== null) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);

      const event = parseRuntimeEventBlock(block);
      if (event !== undefined) {
        events.push(event);
      }

      boundary = eventBoundary.exec(this.buffer);
    }

    return events;
  }
}

export const parseRuntimeEventBlock = (
  block: string,
): RuntimeEvent | undefined => {
  const lines = block.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const dataLines: string[] = [];
  let declaredEvent: string | undefined;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field =
      separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      declaredEvent = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch (error) {
    throw new ApiClientError("The event stream contained invalid JSON.", {
      cause: error,
    });
  }

  const parsed = RuntimeEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(
      "The event stream contained an invalid runtime event.",
      { cause: parsed.error },
    );
  }

  if (declaredEvent !== undefined && declaredEvent !== parsed.data.type) {
    throw new ApiClientError(
      "The event stream type did not match its event payload.",
    );
  }

  return parsed.data;
};

export interface SkeinApiClient {
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  streamChat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

export const createApiClient = (
  options: ApiClientOptions = {},
): SkeinApiClient => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "");

  return {
    async chat(request, signal) {
      const response = await fetchImplementation(`${baseUrl}/api/v1/chat`, {
        body: JSON.stringify(request),
        headers: JSON_HEADERS,
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      });

      await assertSuccessfulResponse(response);
      return parseChatResponse(await response.json());
    },

    async *streamChat(request, signal) {
      const response = await fetchImplementation(
        `${baseUrl}/api/v1/chat/stream`,
        {
          body: JSON.stringify(request),
          headers: STREAM_HEADERS,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        },
      );

      await assertSuccessfulResponse(response);
      if (response.body === null) {
        throw new ApiClientError("The event stream did not include a body.", {
          status: response.status,
        });
      }

      const parser = new RuntimeEventStreamParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          for (const event of parser.push(
            decoder.decode(value, { stream: true }),
          )) {
            yield event;
          }
        }

        for (const event of parser.push(decoder.decode())) {
          yield event;
        }
        for (const event of parser.finish()) {
          yield event;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, "");

const parseChatResponse = (payload: unknown): ChatResponse => {
  const parsed = ChatResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError("The server returned an invalid chat response.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
};

const assertSuccessfulResponse = async (response: Response): Promise<void> => {
  if (response.ok) {
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const parsed = PublicErrorSchema.safeParse(payload);
  if (parsed.success) {
    throw new ApiClientError(parsed.data.message, {
      publicError: parsed.data,
      status: response.status,
    });
  }

  throw new ApiClientError(`Request failed with status ${response.status}.`, {
    status: response.status,
  });
};
