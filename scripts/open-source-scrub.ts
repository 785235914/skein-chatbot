import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { parse as parsePublicSuffix } from "tldts";

export interface PublicFile {
  readonly path: string;
  readonly text: string;
}

export interface ScrubViolation {
  readonly line: number;
  readonly path: string;
  readonly rule: ScrubRule;
}

export type ScrubRule =
  | "CANDIDATE_READ_ERROR"
  | "CONNECTION_CREDENTIAL"
  | "CORE_PROVIDER_IDENTIFIER"
  | "CREDENTIAL_TOKEN"
  | "ENV_CREDENTIAL"
  | "JWT"
  | "LOCAL_PATH"
  | "PRIVATE_DNS"
  | "PRIVATE_IP"
  | "PRIVATE_KEY"
  | "PROTECTED_IDENTIFIER";

const protectedIdentifiers = [
  ["ze", "iss"].join(""),
  ["de", "c"].join(""),
  ["m", "365"].join(""),
  ["it", " ", "support"].join(""),
];
const coreProviderIdentifier = ["di", "fy"].join("");
const coreProviderPascalIdentifier = `${coreProviderIdentifier[0]?.toUpperCase()}${coreProviderIdentifier.slice(1)}`;
const excludedDirectoryNames = new Set([
  ".git",
  ".superpowers",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
]);
const credentialNames = new Set([
  "ACCESS_TOKEN",
  "API_KEY",
  "AUTH_TOKEN",
  "CLIENT_SECRET",
  "DATABASE_URL",
  "PASSWORD",
  "PRIVATE_KEY",
  "SECRET",
  "TOKEN",
]);
const documentationHostnameSuffixes = ["example.com", "example.test"];
const nonPublicIcannSuffixes = new Set(["home.arpa"]);

const lineForIndex = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

const isPrivateIp = (candidate: string): boolean => {
  const octets = candidate.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) {
    return false;
  }
  const [first, second = -1] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

const isCredentialName = (name: string): boolean =>
  credentialNames.has(name) ||
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)$/u.test(name);

const containsCredentialAssignment = (line: string): boolean => {
  const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
  const name = match?.[1];
  const rawValue = match?.[2];
  if (
    name === undefined ||
    rawValue === undefined ||
    !isCredentialName(name.toUpperCase())
  ) {
    return false;
  }
  const value = rawValue.replace(/^['"]|['"]$/gu, "").trim();
  return (
    value.length > 0 &&
    !/^(?:example|placeholder|replace-me|replace-with-base64-32-byte-key)$/iu.test(
      value,
    )
  );
};

const addMatches = (
  violations: ScrubViolation[],
  path: string,
  text: string,
  rule: ScrubRule,
  pattern: RegExp,
  shouldReport: (match: string, index: number) => boolean = () => true,
): void => {
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (shouldReport(match[0], index)) {
      violations.push({ line: lineForIndex(text, index), path, rule });
    }
  }
};

const isPublicOrAllowedHostname = (hostname: string): boolean => {
  const lowerHostname = hostname.toLowerCase();
  const normalizedHostname = lowerHostname.endsWith(".")
    ? lowerHostname.slice(0, -1)
    : lowerHostname;
  const address = normalizedHostname.replace(/^\[|\]$/gu, "");
  if (
    address === "localhost" ||
    address === "::1" ||
    (isIP(address) === 4 && address.startsWith("127."))
  ) {
    return true;
  }
  if (isIP(address) !== 0 || normalizedHostname.length > 253) {
    return false;
  }
  if (
    documentationHostnameSuffixes.some(
      (suffix) =>
        normalizedHostname === suffix ||
        normalizedHostname.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }
  const parsed = parsePublicSuffix(normalizedHostname, {
    allowPrivateDomains: true,
    detectIp: true,
    validateHostname: true,
  });
  return (
    parsed.domain !== null &&
    parsed.isIcann === true &&
    parsed.isPrivate === false &&
    parsed.publicSuffix !== null &&
    !nonPublicIcannSuffixes.has(parsed.publicSuffix)
  );
};

const isHttpUrlPathMatch = (
  text: string,
  index: number,
  match: string,
): boolean => {
  if (!match.startsWith("/")) {
    return false;
  }
  const prefix = /https?:\/\/[^\s"'<>]*$/iu.exec(text.slice(0, index))?.[0];
  if (prefix === undefined) {
    return false;
  }
  const suffix = /^[^\s"'<>]*/u.exec(text.slice(index))?.[0] ?? "";
  const candidate = `${prefix}${suffix}`;
  let hostname = "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    hostname = url.hostname;
  } catch {
    return false;
  }
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(candidate);
  if (
    authority?.[1] === undefined ||
    authority[1].length === 0 ||
    !isPublicOrAllowedHostname(hostname)
  ) {
    return false;
  }
  const pathEnd = Math.min(
    ...[candidate.indexOf("?"), candidate.indexOf("#")].filter(
      (offset) => offset >= 0,
    ),
    candidate.length,
  );
  return prefix.length >= authority[0].length && prefix.length < pathEnd;
};

const isSyntheticToken = (value: string): boolean =>
  /(?:must-not-leak|1234567890abcdef)$/iu.test(value);

const isSyntheticKeyOrJwt = (value: string): boolean =>
  value.includes("ZXhhbXBsZ") ||
  value.includes("MTIzNDU2Nzg5MA") ||
  value.includes("signature123456");

const isClearlySyntheticConnectionPart = (value: string): boolean =>
  value.length === 0 ||
  /^\$\{[^}]+\}$/u.test(value) ||
  /^(?:alice|example|mock|p4ssw0rd-value|placeholder|replace-me|secret-value|skein|synthetic|test|user)$/iu.test(value);

const isCoreProviderIdentifier = (value: string): boolean =>
  value.split(/[_-]+/u).some(
    (part) =>
      part.toLowerCase().startsWith(coreProviderIdentifier) ||
      part.includes(coreProviderPascalIdentifier),
  );

const isSafeExampleConnection = (
  username: string,
  password: string,
  host: string,
): boolean =>
  /^(?:127\.0\.0\.1|localhost|(?:[^.]+\.)?example\.(?:com|test))$/iu.test(host) &&
  isClearlySyntheticConnectionPart(username) &&
  isClearlySyntheticConnectionPart(password);

const isPrivateIpv6 = (candidate: string): boolean => {
  const normalized = candidate.replace(/^\[|\]$/gu, "").toLowerCase();
  return isIP(normalized) === 6 && (/^f[c-d][0-9a-f]*:/u.test(normalized) || /^fe[89ab][0-9a-f]*:/u.test(normalized));
};

/** Pure deterministic scan for already-selected public text files. */
export const scanPublicFiles = (
  files: readonly PublicFile[],
): readonly ScrubViolation[] => {
  const violations: ScrubViolation[] = [];
  for (const file of files) {
    const path = file.path.split("\\").join("/");
    const text = file.text;
    for (const identifier of protectedIdentifiers) {
      addMatches(
        violations,
        path,
        text,
        "PROTECTED_IDENTIFIER",
        new RegExp(`\\b${identifier}\\b`, "giu"),
      );
    }
    if (path.startsWith("packages/core/")) {
      addMatches(
        violations,
        path,
        text,
        "CORE_PROVIDER_IDENTIFIER",
        /\b[A-Za-z][A-Za-z0-9_-]*\b/gu,
        (match) => isCoreProviderIdentifier(match),
      );
    }
    addMatches(
      violations,
      path,
      text,
      "LOCAL_PATH",
      /(?:\b[A-Za-z]:[\\/](?:[^\s"'\\/]+[\\/])*(?:repo|repository|users|workspace|workspaces|project|projects|develop)(?:[\\/][^\s"']*)?|\\\\[A-Za-z0-9][A-Za-z0-9.-]*[\\/][A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][^\s"']+)?|\/(?:Users|home|mnt|opt|srv|var|workspace)\/[^\s"']+)/giu,
      (match, index) => !isHttpUrlPathMatch(text, index, match),
    );
    addMatches(
      violations,
      path,
      text,
      "PRIVATE_DNS",
      /\b(?:[A-Za-z0-9-]+\.)+(?:internal|intranet|local)\b(?![A-Za-z0-9.-])/giu,
      (match, index) => text.slice(index - 1, index + match.length) !== ".env.local",
    );
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) {
      if (isPrivateIp(match[0])) {
        violations.push({
          line: lineForIndex(text, match.index ?? 0),
          path,
          rule: "PRIVATE_IP",
        });
      }
    }
    for (const match of text.matchAll(/(?<![0-9A-Fa-f:])(?:\[[0-9A-Fa-f:]+\]|[0-9A-Fa-f:]+)(?![0-9A-Fa-f:])/gu)) {
      if (isPrivateIpv6(match[0])) {
        violations.push({
          line: lineForIndex(text, match.index ?? 0),
          path,
          rule: "PRIVATE_IP",
        });
      }
    }
    addMatches(
      violations,
      path,
      text,
      "CREDENTIAL_TOKEN",
      /\b(?:sk|app)-[A-Za-z0-9_-]{16,}\b/gu,
      (match) => !isSyntheticToken(match),
    );
    addMatches(violations, path, text, "CREDENTIAL_TOKEN", /\b(?:gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{16,}\b/gu);
    addMatches(
      violations,
      path,
      text,
      "JWT",
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      (match) => !isSyntheticKeyOrJwt(match),
    );
    addMatches(
      violations,
      path,
      text,
      "PRIVATE_KEY",
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu,
      (match) => !isSyntheticKeyOrJwt(match),
    );
    for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/@:]*):([^\s/@]*)@([A-Za-z0-9.-]+)(?::\d+)?/gu)) {
      const username = match[1] ?? "";
      const password = match[2] ?? "";
      const host = match[3] ?? "";
      if (!isSafeExampleConnection(username, password, host)) {
        violations.push({
          line: lineForIndex(text, match.index ?? 0),
          path,
          rule: "CONNECTION_CREDENTIAL",
        });
      }
    }
    if (basename(path).startsWith(".env")) {
      text.split(/\r?\n/u).forEach((line, index) => {
        if (containsCredentialAssignment(line)) {
          violations.push({ line: index + 1, path, rule: "ENV_CREDENTIAL" });
        }
      });
    }
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
};

export const isPublicCandidatePath = (path: string): boolean =>
  !path.split("/").some((segment) => excludedDirectoryNames.has(segment));

const candidatePaths = (root: string): string[] => {
  const git = (arguments_: readonly string[]): string =>
    execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });
  const candidates = new Set(
    [
      git(["ls-files", "--cached", "-z"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]
      .flatMap((output) => output.split("\0"))
      .filter(Boolean)
      .map((path) => path.split("\\").join("/"))
      .filter(isPublicCandidatePath),
  );
  return [...candidates].sort();
};

interface CandidateReadResult {
  readonly files: readonly PublicFile[];
  readonly unreadablePaths: readonly string[];
}

const readCandidateFiles = (root: string): CandidateReadResult => {
  const files: PublicFile[] = [];
  const unreadablePaths: string[] = [];
  for (const path of candidatePaths(root)) {
    try {
      const text = readFileSync(resolve(root, path), "utf8");
      if (!text.includes("\0")) {
        files.push({ path, text });
      }
    } catch {
      unreadablePaths.push(path);
    }
  }
  return { files, unreadablePaths };
};

const isDirectInvocation = (): boolean => {
  const modulePath = fileURLToPath(import.meta.url);
  return process.argv.some(
    (argument) =>
      resolve(argument) === modulePath ||
      argument.endsWith("/open-source-scrub.ts") ||
      argument.endsWith("\\\\open-source-scrub.ts"),
  );
};

if (isDirectInvocation()) {
  const candidates = readCandidateFiles(process.cwd());
  const violations = [
    ...scanPublicFiles(candidates.files),
    ...candidates.unreadablePaths.map((path) => ({
      line: 0,
      path,
      rule: "CANDIDATE_READ_ERROR" as const,
    })),
  ];
  for (const violation of violations) {
    process.stderr.write(`${violation.rule} ${violation.path}:${violation.line}\n`);
  }
  if (violations.length === 0) {
    process.stdout.write("open-source scrub: clean\n");
  } else {
    process.exitCode = 1;
  }
}
