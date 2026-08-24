import {
  RuntimeError,
  RuntimeErrorCode,
  type BusinessOrchestrator,
  type OrchestrationEvent,
  type OrchestrationInput,
  type OrchestrationResult,
} from "@skein-chatbot/core";

import {
  createDifyInvalidResponseError,
  mapDifyHttpError,
  mapDifyStreamError,
  mapDifyTransportError,
} from "./errors.js";
import {
  mapDifyInputs,
  normalizeDifyResponse,
  validateDifyFiles,
} from "./normalizer.js";
import { getDifyPath, isDifyRecord } from "./path-access.js";
import { DifyProfileSchema } from "./profile-schema.js";
import { parseDifySseData } from "./sse.js";
import type {
  DifyBusinessOrchestratorOptions,
  DifyFetch,
  DifyFile,
  DifyProfile,
} from "./types.js";

const MAX_BLOCKING_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_ANSWER_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_USER_LENGTH = 255;

interface DifyRequestEnvelope {
  inputs: Record<string, unknown>;
  query: string;
  response_mode: "blocking" | "streaming";
  user: string;
  conversation_id?: string;
  files?: readonly DifyFile[];
}

const normalizeBaseUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeError(
      RuntimeErrorCode.VALIDATION_ERROR,
      "The Dify base URL is invalid.",
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
      "The Dify base URL is invalid.",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
};

const readBoundedText = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  let completed = false;
  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return chunk === undefined
        ? decoder.decode()
        : decoder.decode(chunk, { stream });
    } catch {
      throw createDifyInvalidResponseError();
    }
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        text += decode();
        return text;
      }
      size += next.value.byteLength;
      if (size > maximumBytes) {
        throw createDifyInvalidResponseError();
      }
      text += decode(next.value, true);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
};

const safeProviderCode = async (response: Response): Promise<string> => {
  try {
    const text = await readBoundedText(response, MAX_ERROR_RESPONSE_BYTES);
    const value: unknown = JSON.parse(text);
    if (isDifyRecord(value) && typeof value.code === "string") {
      return value.code.slice(0, 128);
    }
  } catch {
    // HTTP status remains authoritative; provider body is intentionally ignored.
  }
  return "";
};

const parseJsonObject = (text: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw createDifyInvalidResponseError();
  }
  if (!isDifyRecord(value)) {
    throw createDifyInvalidResponseError();
  }
  return value;
};

const assertResponseContentType = (
  response: Response,
  responseMode: "blocking" | "streaming",
): void => {
  const contentType = response.headers.get("content-type");
  if (contentType === null) {
    return;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  const valid =
    responseMode === "streaming"
      ? mediaType === "text/event-stream"
      : mediaType === "application/json" || mediaType?.endsWith("+json") === true;
  if (!valid) {
    throw createDifyInvalidResponseError();
  }
};

const statusOfWorkflowEvent = (
  payload: Record<string, unknown>,
): string | undefined => {
  const direct = payload.status;
  if (typeof direct === "string") {
    return direct.toLowerCase();
  }
  const data = payload.data;
  if (isDifyRecord(data) && typeof data.status === "string") {
    return data.status.toLowerCase();
  }
  return undefined;
};

const isWorkflowFailureStatus = (status: string | undefined): boolean =>
  status === "failed" ||
  status === "stopped" ||
  status === "canceled" ||
  status === "cancelled";

/** Generic Dify chat-message adapter. It owns no runtime or database state. */
export class DifyBusinessOrchestrator implements BusinessOrchestrator {
  readonly providerKey: string;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly profile: DifyProfile;
  private readonly fetchImplementation: DifyFetch;
  private readonly filesProvider: DifyBusinessOrchestratorOptions["files"];

  constructor(options: DifyBusinessOrchestratorOptions) {
    this.endpoint = `${normalizeBaseUrl(options.baseUrl)}/chat-messages`;
    if (options.apiKey.trim().length === 0) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The Dify app key is required.",
      );
    }
    const parsedProfile = DifyProfileSchema.safeParse(options.profile);
    if (!parsedProfile.success) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The Dify profile is invalid.",
      );
    }
    this.profile = parsedProfile.data as DifyProfile;
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.filesProvider = options.files;

    const namespace = options.providerKey?.trim();
    if (namespace !== undefined && namespace.length === 0) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The Dify provider key is invalid.",
      );
    }
    this.providerKey =
      namespace === undefined || namespace === this.profile.name
        ? this.profile.name
        : `${namespace}:${this.profile.name}`;
  }

  async execute(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    if (this.profile.transport.executeResponseMode === "streaming") {
      let completed: OrchestrationResult | undefined;
      for await (const event of this.stream(input, signal)) {
        if (event.type === "completed") {
          completed = event.result;
        }
      }
      if (completed === undefined) {
        throw createDifyInvalidResponseError();
      }
      return completed;
    }

    const response = await this.request(input, "blocking", signal);
    try {
      const text = await readBoundedText(
        response,
        MAX_BLOCKING_RESPONSE_BYTES,
      );
      const result = normalizeDifyResponse(
        parseJsonObject(text),
        this.profile,
      );
      this.assertConversationBinding(input, result.providerConversationId);
      return result;
    } catch (error) {
      throw mapDifyTransportError(error, signal);
    }
  }

  async *stream(
    input: OrchestrationInput,
    signal?: AbortSignal,
  ): AsyncIterable<OrchestrationEvent> {
    const response = await this.request(input, "streaming", signal);
    if (response.body === null) {
      throw createDifyInvalidResponseError();
    }

    let answer = "";
    let answerBytes = 0;
    let conversationId: string | undefined;
    let sawAgentMessage = false;
    let sawWorkflowStarted = false;
    let pendingWorkflowResult: OrchestrationResult | undefined;
    let sawWorkflowFailure = false;
    let lastStatus: string | undefined;

    try {
      for await (const data of parseDifySseData(response.body, signal)) {
        this.throwIfRequestAborted(signal);
        if (data.trim() === "[DONE]") {
          throw createDifyInvalidResponseError();
        }
        const payload = parseJsonObject(data);
        const eventValue = getDifyPath(payload, this.profile.stream.event);
        if (typeof eventValue !== "string") {
          throw createDifyInvalidResponseError();
        }

        conversationId = this.observeConversationId(
          payload,
          conversationId,
          input,
        );

        if (this.profile.stream.errorEvents.includes(eventValue)) {
          throw mapDifyStreamError(payload);
        }
        if (eventValue === "message_replace") {
          // Skein V1 exposes additive deltas and cannot retract prior output.
          throw createDifyInvalidResponseError();
        }
        if (
          eventValue === "workflow_paused" ||
          eventValue === "human_input_required"
        ) {
          throw new RuntimeError(
            RuntimeErrorCode.ORCHESTRATION_FAILED,
            "The provider requires an unsupported paused interaction.",
          );
        }
        if (eventValue === "workflow_started") {
          sawWorkflowStarted = true;
        }
        if (eventValue === "workflow_finished") {
          if (isWorkflowFailureStatus(statusOfWorkflowEvent(payload))) {
            sawWorkflowFailure = true;
            continue;
          }
          if (pendingWorkflowResult !== undefined) {
            yield* this.completedEvents(pendingWorkflowResult);
            return;
          }
          continue;
        }

        const mappedStatus = this.profile.stream.statusMapping[eventValue];
        if (mappedStatus !== undefined && mappedStatus !== lastStatus) {
          lastStatus = mappedStatus;
          yield { type: "status", status: mappedStatus };
        }

        if (this.profile.stream.textEvents.includes(eventValue)) {
          const text = getDifyPath(payload, this.profile.stream.text);
          if (typeof text !== "string") {
            throw createDifyInvalidResponseError();
          }
          if (eventValue === "message" && sawAgentMessage) {
            // New Agent sends a closing message containing the full answer.
            answer = text;
            answerBytes = Buffer.byteLength(text, "utf8");
          } else {
            answer += text;
            answerBytes += Buffer.byteLength(text, "utf8");
            if (text.length > 0) {
              yield { type: "delta", text };
            }
          }
          if (answerBytes > MAX_STREAM_ANSWER_BYTES) {
            throw createDifyInvalidResponseError();
          }
          if (eventValue === "agent_message") {
            sawAgentMessage = true;
          }
        }

        if (this.profile.stream.terminalEvents.includes(eventValue)) {
          const result = normalizeDifyResponse(payload, this.profile, {
            answer,
            ...(conversationId === undefined ? {} : { conversationId }),
          });
          this.assertConversationBinding(input, result.providerConversationId);
          if (sawWorkflowStarted) {
            pendingWorkflowResult = result;
            continue;
          }
          yield* this.completedEvents(result);
          return;
        }
      }
      if (sawWorkflowFailure) {
        throw new RuntimeError(
          RuntimeErrorCode.ORCHESTRATION_FAILED,
          "The provider workflow failed without an error event.",
        );
      }
      throw createDifyInvalidResponseError();
    } catch (error) {
      throw mapDifyTransportError(error, signal);
    }
  }

  private async request(
    input: OrchestrationInput,
    responseMode: "blocking" | "streaming",
    signal?: AbortSignal,
  ): Promise<Response> {
    this.throwIfRequestAborted(signal);
    if (
      input.user.userId.length === 0 ||
      input.user.userId.length > MAX_USER_LENGTH
    ) {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The provider user identifier is invalid.",
      );
    }

    const files = validateDifyFiles(this.filesProvider?.(input));
    const envelope: DifyRequestEnvelope = {
      inputs: mapDifyInputs(input, this.profile),
      query: input.query,
      response_mode: responseMode,
      user: input.user.userId,
      ...(input.providerConversationId === undefined
        ? {}
        : { conversation_id: input.providerConversationId }),
      ...(files === undefined || files.length === 0 ? {} : { files }),
    };

    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch {
      throw new RuntimeError(
        RuntimeErrorCode.VALIDATION_ERROR,
        "The provider request could not be serialized.",
      );
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          accept:
            responseMode === "streaming"
              ? "text/event-stream"
              : "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw mapDifyTransportError(error, signal);
    }

    if (!response.ok) {
      const providerCode = await safeProviderCode(response);
      this.throwIfRequestAborted(signal);
      throw mapDifyHttpError(response.status, providerCode);
    }
    assertResponseContentType(response, responseMode);
    return response;
  }

  private observeConversationId(
    payload: Record<string, unknown>,
    previous: string | undefined,
    input: OrchestrationInput,
  ): string | undefined {
    const selected = getDifyPath(payload, this.profile.stream.conversationId);
    if (selected === undefined || selected === null) {
      return previous;
    }
    if (typeof selected !== "string" || selected.length === 0) {
      throw createDifyInvalidResponseError();
    }
    if (
      (previous !== undefined && previous !== selected) ||
      (input.providerConversationId !== undefined &&
        input.providerConversationId !== selected)
    ) {
      throw createDifyInvalidResponseError();
    }
    return selected;
  }

  private throwIfRequestAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw mapDifyTransportError(signal.reason, signal);
    }
  }

  private assertConversationBinding(
    input: OrchestrationInput,
    conversationId: string | undefined,
  ): void {
    if (
      conversationId === undefined ||
      (input.providerConversationId !== undefined &&
        conversationId !== input.providerConversationId)
    ) {
      throw createDifyInvalidResponseError();
    }
  }

  private *completedEvents(
    result: OrchestrationResult,
  ): Iterable<OrchestrationEvent> {
    for (const source of result.sources) {
      yield { type: "source", source };
    }
    yield { type: "completed", result };
  }
}

export const createDifyBusinessOrchestrator = (
  options: DifyBusinessOrchestratorOptions,
): DifyBusinessOrchestrator => new DifyBusinessOrchestrator(options);
