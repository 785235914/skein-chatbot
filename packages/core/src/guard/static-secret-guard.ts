import type { GuardInput, GuardResult } from "../ports/guard.js";
import { isClearlyQuotedDiscussion } from "./discussion.js";
import { NormalizedStaticGuard } from "./static-guard.js";
import type { GuardTextOptions } from "./text.js";

export const CREDENTIAL_PLACEHOLDER = "[REDACTED_CREDENTIAL]";

interface SecretRule {
  readonly riskType: string;
  readonly pattern: RegExp;
}

const secretRules: readonly SecretRule[] = [
  {
    riskType: "CREDENTIAL_PRIVATE_KEY",
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu,
  },
  {
    riskType: "CREDENTIAL_CONNECTION_STRING",
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s]+@[^\s]+/giu,
  },
  {
    riskType: "CREDENTIAL_AUTHORIZATION",
    pattern:
      /\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
  },
  {
    riskType: "CREDENTIAL_AUTHORIZATION",
    pattern: /\bbearer\s+[^\s,;]+/giu,
  },
  {
    riskType: "CREDENTIAL_PASSWORD",
    pattern:
      /\b(?:password|passwd|pwd)\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
  },
  {
    riskType: "CREDENTIAL_API_KEY",
    pattern:
      /\bapi[_ -]?key\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
  },
  {
    riskType: "CREDENTIAL_ACCESS_TOKEN",
    pattern:
      /\baccess[_ -]?token\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
  },
  {
    riskType: "CREDENTIAL_REFRESH_TOKEN",
    pattern:
      /\brefresh[_ -]?token\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
  },
  {
    riskType: "CREDENTIAL_CLIENT_SECRET",
    pattern:
      /\bclient[_ -]?secret\b\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/giu,
  },
  {
    riskType: "CREDENTIAL_ONE_TIME_CODE",
    pattern:
      /\b(?:mfa|2fa|otp|one[- ]?time(?:\s+(?:password|code))?)\s*(?:code)?\s*[:=]\s*["']?\d{4,10}["']?/giu,
  },
  {
    riskType: "CREDENTIAL_JWT",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  },
];

const credentialNoun =
  /\b(?:credentials?|passwords?|api[_ -]?keys?|access[_ -]?tokens?|refresh[_ -]?tokens?|client[_ -]?secrets?|private[_ -]?keys?|mfa|otp)\b/iu;
const exfiltrationAction =
  /\b(?:steal|reveal|show|dump|export|exfiltrate|extract|obtain|harvest|leak)\b/iu;
const bypassCredentialControls =
  /\bbypass\b[^\r\n]{0,80}\b(?:credential|password|token|secret|key|mfa|otp|access)\b/iu;

const isCredentialTheftInstruction = (text: string): boolean =>
  (credentialNoun.test(text) && exfiltrationAction.test(text)) ||
  bypassCredentialControls.test(text);

export class StaticSecretGuard extends NormalizedStaticGuard {
  constructor(options: GuardTextOptions = {}) {
    super(options);
  }

  protected evaluateNormalized(input: GuardInput): GuardResult {
    if (
      isCredentialTheftInstruction(input.text) &&
      !isClearlyQuotedDiscussion(input.text, isCredentialTheftInstruction)
    ) {
      return {
        action: "BLOCK",
        safe: false,
        riskTypes: ["CREDENTIAL_THEFT_REQUEST"],
        reason: "Credential exfiltration instructions are not allowed.",
      };
    }

    const riskTypes: string[] = [];
    let sanitizedText = input.text;
    for (const rule of secretRules) {
      sanitizedText = sanitizedText.replace(rule.pattern, () => {
        if (!riskTypes.includes(rule.riskType)) {
          riskTypes.push(rule.riskType);
        }
        return CREDENTIAL_PLACEHOLDER;
      });
    }

    if (riskTypes.length === 0) {
      return { action: "ALLOW", safe: true, riskTypes: [] };
    }

    return {
      action: "REDACT",
      safe: true,
      riskTypes,
      sanitizedText,
      reason: "Credential material was redacted.",
    };
  }
}
