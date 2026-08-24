import { throwIfAborted } from "../errors/runtime-error.js";
import type {
  ContentSafetyPolicyPort,
  EnterprisePolicyPort,
  GuardInput,
  GuardResult,
  PiiDetectionPort,
} from "../ports/guard.js";

const allow = (): GuardResult => ({
  action: "ALLOW",
  safe: true,
  riskTypes: [],
});

export class NoopPiiDetector implements PiiDetectionPort {
  async evaluate(
    _input: GuardInput,
    signal?: AbortSignal,
  ): Promise<GuardResult> {
    throwIfAborted(signal);
    return allow();
  }
}

export class NoopContentSafetyPolicy implements ContentSafetyPolicyPort {
  async evaluate(
    _input: GuardInput,
    signal?: AbortSignal,
  ): Promise<GuardResult> {
    throwIfAborted(signal);
    return allow();
  }
}

export class NoopEnterprisePolicy implements EnterprisePolicyPort {
  async evaluate(
    _input: GuardInput,
    signal?: AbortSignal,
  ): Promise<GuardResult> {
    throwIfAborted(signal);
    return allow();
  }
}
