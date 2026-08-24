import type { GuardInput, GuardResult } from "../ports/guard.js";
import { NormalizedStaticGuard } from "./static-guard.js";
import type { GuardTextOptions } from "./text.js";

const unsafeUrl =
  /\b(?:javascript|data|file|vbscript|chrome|about|ftp|ssh|sftp):[^\s]*/iu;
const credentialBearingUserInfo =
  /\bhttps?:\/\/[^/\s@]+@[^\s]+/iu;
const credentialBearingUrlParameter =
  /[?#&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|authorization)=[^&#\s]+/iu;

const internalLeakPatterns: readonly RegExp[] = [
  /\b(?:the\s+)?(?:system|hidden|developer)\s+(?:prompt|instructions?)\s*(?:is\b\s*)?:/iu,
  /\binternal\s+(?:trace|tool)\s+payload\b/iu,
  /["']?\breasoning_content\b["']?\s*:/iu,
  /\b(?:raw\s+)?mcp\s+(?:tool\s+)?trace\b/iu,
  /\btools\.call\s*\(/iu,
  /\bprovider[ _-]+(?:response|request|metadata|internals?)(?:[ _-]+metadata)?\b/iu,
];

export class StaticOutputLeakGuard extends NormalizedStaticGuard {
  constructor(options: GuardTextOptions = {}) {
    super(options);
  }

  protected evaluateNormalized(input: GuardInput): GuardResult {
    if (input.phase !== "OUTPUT") {
      return { action: "ALLOW", safe: true, riskTypes: [] };
    }

    if (
      unsafeUrl.test(input.text) ||
      credentialBearingUserInfo.test(input.text) ||
      credentialBearingUrlParameter.test(input.text)
    ) {
      return {
        action: "BLOCK",
        safe: false,
        riskTypes: ["OUTPUT_UNSAFE_URL"],
        reason: "The output contains an unsafe URL.",
      };
    }

    if (internalLeakPatterns.some((pattern) => pattern.test(input.text))) {
      return {
        action: "BLOCK",
        safe: false,
        riskTypes: ["OUTPUT_INTERNAL_LEAK"],
        reason: "The output contains internal-only material.",
      };
    }

    return { action: "ALLOW", safe: true, riskTypes: [] };
  }
}
