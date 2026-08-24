import type {
  AbortSessionResponse,
  ChatResponse,
  MessageView,
  ResetSessionResponse,
  RuntimeEvent,
  SessionView,
} from "@skein-chatbot/contracts";
import type { RuntimeChatRequest } from "@skein-chatbot/core";

export type ApiChatInput = RuntimeChatRequest;

/**
 * Narrow application-facing Runtime surface. Keeping the HTTP adapter against
 * this shape makes the production Runtime and focused API fakes interchangeable.
 */
export interface ApiRuntime {
  abortSession(sessionId: string): Promise<AbortSessionResponse>;
  chat(input: ApiChatInput, signal?: AbortSignal): Promise<ChatResponse>;
  close?(): Promise<void>;
  getMessages(sessionId: string): Promise<readonly MessageView[]>;
  getSession(sessionId: string): Promise<SessionView>;
  resetSession(sessionId: string): Promise<ResetSessionResponse>;
  stream(input: ApiChatInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
}
