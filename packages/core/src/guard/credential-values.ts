const assignmentValue =
  /\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|token)\b\s*[:=]\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;&#]+))/giu;
const authorizationValue =
  /\bauthorization\s*[:=]\s*[A-Za-z][A-Za-z0-9+.-]*\s+([^\s,;]+)/giu;
const bearerValue =
  /\b(?:authorization\s*[:=]\s*)?bearer\s+([^\s,;]+)/giu;
const oneTimeCodeValue =
  /\b(?:mfa|2fa|otp|one[- ]?time(?:\s+(?:password|code))?)\s*(?:code)?\s*[:=]\s*["']?(\d{4,10})["']?/giu;
const connectionPassword =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^@\s/]+)@/giu;
const jwtValue =
  /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu;
const privateKeyBody =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----([\s\S]*?)-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu;

const appendMatchValues = (
  values: string[],
  text: string,
  pattern: RegExp,
): void => {
  for (const match of text.matchAll(pattern)) {
    const value = match.slice(1).find((candidate) => candidate !== undefined);
    if (value !== undefined && value.length > 0 && !values.includes(value)) {
      values.push(value);
    }
  }
};

export const extractCredentialValues = (text: string): readonly string[] => {
  const values: string[] = [];
  appendMatchValues(values, text, assignmentValue);
  appendMatchValues(values, text, authorizationValue);
  appendMatchValues(values, text, bearerValue);
  appendMatchValues(values, text, oneTimeCodeValue);
  appendMatchValues(values, text, connectionPassword);
  appendMatchValues(values, text, jwtValue);

  for (const match of text.matchAll(privateKeyBody)) {
    const body = match[1];
    if (body === undefined) {
      continue;
    }
    for (const line of body.split(/\s+/u)) {
      if (line.length > 0 && !values.includes(line)) {
        values.push(line);
      }
    }
  }

  return values;
};
