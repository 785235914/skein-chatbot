import type { GuardInput, GuardResult } from "../ports/guard.js";
import { isClearlyQuotedDiscussion } from "./discussion.js";
import { NormalizedStaticGuard } from "./static-guard.js";
import type { GuardTextOptions } from "./text.js";

const attackPatterns: readonly RegExp[] = [
  /\b(?:ignore|disregard|override|forget)\b[^\r\n]{0,80}\b(?:previous|prior|earlier|system|developer)\b[^\r\n]{0,40}\binstructions?\b/iu,
  /\b(?:reveal|show|display|expose|print|repeat)\b[^\r\n]{0,80}\b(?:hidden|system|developer)\b[^\r\n]{0,30}\b(?:prompt|instructions?)\b/iu,
  /\b(?:disable|bypass|override|remove|turn off)\b[^\r\n]{0,80}\b(?:safety|guardrails?|policy|security|controls?)\b/iu,
  /\b(?:export|exfiltrate|dump|send|leak)\b[^\r\n]{0,80}\b(?:credentials?|passwords?|tokens?|secrets?|api[_ -]?keys?)\b/iu,
  /\b(?:pretend|act)\b[^\r\n]{0,40}\b(?:administrator|admin|root|superuser)\b/iu,
];

const containsAttack = (text: string): boolean =>
  attackPatterns.some((pattern) => pattern.test(text));

export class PromptInjectionGuard extends NormalizedStaticGuard {
  constructor(options: GuardTextOptions = {}) {
    super(options);
  }

  protected evaluateNormalized(input: GuardInput): GuardResult {
    if (
      input.phase !== "INPUT" ||
      !containsAttack(input.text) ||
      isClearlyQuotedDiscussion(input.text, containsAttack)
    ) {
      return { action: "ALLOW", safe: true, riskTypes: [] };
    }

    return {
      action: "BLOCK",
      safe: false,
      riskTypes: ["PROMPT_INJECTION"],
      reason: "Direct prompt-injection instructions are not allowed.",
    };
  }
}
