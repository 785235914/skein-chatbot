import type { ExecutionMode } from "@skein-chatbot/contracts";

export interface RuntimeConfig {
  defaultMode: ExecutionMode;
  recentMessages: number;
  compactionMessageThreshold: number;
  compactionTokenThreshold: number;
  quickTimeoutMs: number;
  deepTimeoutMs: number;
  retryAttempts: number;
  guards: {
    input: boolean;
    output: boolean;
  };
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  defaultMode: "QUICK",
  recentMessages: 8,
  compactionMessageThreshold: 20,
  compactionTokenThreshold: 12_000,
  quickTimeoutMs: 25_000,
  deepTimeoutMs: 60_000,
  retryAttempts: 1,
  guards: Object.freeze({ input: true, output: true }),
});
