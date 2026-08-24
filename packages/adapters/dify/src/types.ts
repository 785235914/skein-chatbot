import type {
  BusinessOrchestrator,
  OrchestrationInput,
} from "@skein-chatbot/core";

export const DIFY_STREAM_STATUS_ALLOWLIST = [
  "Processing request",
  "Searching knowledge",
  "Researching additional sources",
  "Preparing response",
] as const;

export type DifyStreamStatus =
  (typeof DIFY_STREAM_STATUS_ALLOWLIST)[number];

export type DifyCanonicalInput =
  | "query"
  | "context"
  | "conversation"
  | "workflowState"
  | "memory"
  | "mode"
  | "traceId"
  | "turnId"
  | "sessionId"
  | "metadata"
  | "user";

export interface DifyContextPatchMapping {
  conversation?: string;
  workflowState?: string;
}

export type DifyPathSelection = string | readonly string[];

export interface DifyResponseMapping {
  answer: string;
  status?: string;
  sources?: string;
  followUpQuestion?: string;
  followUpGuidance?: string;
  conversationId: string;
  contextPatch?: DifyContextPatchMapping;
}

export interface DifySourceMapping {
  id?: DifyPathSelection;
  title: DifyPathSelection;
  url?: DifyPathSelection;
  provider?: DifyPathSelection;
  metadata?: DifyPathSelection;
}

export interface DifyStreamMapping {
  event: string;
  text: string;
  conversationId: string;
  textEvents: readonly string[];
  terminalEvents: readonly string[];
  errorEvents: readonly string[];
  statusMapping: Readonly<Record<string, DifyStreamStatus>>;
}

export interface DifyTransportProfile {
  /** Use streaming-to-buffer for providers that do not offer blocking mode. */
  executeResponseMode: "blocking" | "streaming";
}

export interface DifyProfile {
  name: string;
  request: Partial<Record<DifyCanonicalInput, string>>;
  modeMapping: {
    QUICK: string;
    DEEP: string;
  };
  response: DifyResponseMapping;
  statusMapping: Readonly<
    Record<string, "ANSWER" | "PARTIAL" | "NO_EVIDENCE" | "HANDOFF">
  >;
  source: DifySourceMapping;
  stream: DifyStreamMapping;
  transport: DifyTransportProfile;
}

export type DifyFileType =
  | "document"
  | "image"
  | "audio"
  | "video"
  | "custom";

export type DifyFile =
  | {
      type: DifyFileType;
      transfer_method: "remote_url";
      url: string;
    }
  | {
      type: DifyFileType;
      transfer_method: "local_file";
      upload_file_id: string;
    };

export type DifyFilesProvider = (
  input: OrchestrationInput,
) => readonly DifyFile[] | undefined;

export type DifyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DifyBusinessOrchestratorOptions {
  baseUrl: string;
  apiKey: string;
  profile: DifyProfile;
  providerKey?: string;
  fetch?: DifyFetch;
  files?: DifyFilesProvider;
}

export interface LoadDifyProfileOptions {
  name: string;
  directory?: string;
}

export type DifyOrchestrator = BusinessOrchestrator;
