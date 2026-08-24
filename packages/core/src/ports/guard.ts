export type GuardAction = "ALLOW" | "REDACT" | "REVIEW" | "BLOCK";
export type GuardPhase = "INPUT" | "OUTPUT";

export interface GuardResult {
  action: GuardAction;
  safe: boolean;
  riskTypes: string[];
  sanitizedText?: string;
  reason?: string;
}

export interface GuardInput {
  phase: GuardPhase;
  traceId: string;
  sessionId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface GuardPort {
  evaluate(input: GuardInput, signal?: AbortSignal): Promise<GuardResult>;
}

export interface PiiDetectionPort {
  evaluate(input: GuardInput, signal?: AbortSignal): Promise<GuardResult>;
}

export interface ContentSafetyPolicyPort {
  evaluate(input: GuardInput, signal?: AbortSignal): Promise<GuardResult>;
}

export interface EnterprisePolicyPort {
  evaluate(input: GuardInput, signal?: AbortSignal): Promise<GuardResult>;
}
