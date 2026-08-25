import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  isPublicCandidatePath,
  scanPublicFiles,
  type PublicFile,
} from "./open-source-scrub.js";

const scrubScript = fileURLToPath(
  new URL("./open-source-scrub.ts", import.meta.url),
);
const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const repositoryFixturePaths: string[] = [];
const gitFixtureRoots: string[] = [];

const joined = (...parts: readonly string[]): string => parts.join("");

const file = (path: string, text: string): PublicFile => ({ path, text });

afterEach(async () => {
  await Promise.all(
    repositoryFixturePaths.splice(0).map((path) => rm(path, { force: true })),
  );
  await Promise.all(
    gitFixtureRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const createCommittedFixture = async (
  path: string,
  contents: string,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "skein-scrub-git-"));
  gitFixtureRoots.push(root);
  const target = join(root, path);
  await writeFile(target, contents, "utf8").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", path], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
};

const runScrub = (root: string) =>
  spawnSync(process.execPath, [tsxCli, scrubScript], {
    cwd: root,
    encoding: "utf8",
  });

describe("scanPublicFiles", () => {
  it("accepts controlled public and synthetic content", () => {
    const result = scanPublicFiles([
      file("README.md", "See https://example.com/docs and http://127.0.0.1:3000."),
      file(".env.example", "API_KEY=\nDATABASE_URL=\n"),
      file("test/fixture.ts", 'const token = "synthetic-fixture-value";'),
    ]);

    expect(result).toEqual([]);
  });

  it("allows only the documented resume-secret placeholder", () => {
    expect(
      scanPublicFiles([
        file(
          ".env.example",
          "SESSION_RESUME_SECRET=replace-with-base64-32-byte-key",
        ),
      ]),
    ).toEqual([]);
    expect(
      scanPublicFiles([
        file(
          ".env.example",
          "SESSION_RESUME_SECRET=replace-with-base64-32-byte-key-extra",
        ),
      ]),
    ).toEqual([
      { line: 1, path: ".env.example", rule: "ENV_CREDENTIAL" },
    ]);
  });

  it("reports every required rule family in stable path-line-rule order", () => {
    const company = joined("ze", "iss");
    const localPath = joined("C:", "\\", "Users", "\\", "person", "\\", "checkout");
    const privateHost = joined("service", ".", "internal");
    const privateIp = joined("10", ".", "12", ".", "0", ".", "8");
    const token = joined("sk", "-", "abcDEF0123456789", "abcd");
    const jwt = joined("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "c2lnbmF0dXJl");
    const keyBlock = joined("-----BEGIN ", "PRIVATE KEY-----\nabc\n-----END ", "PRIVATE KEY-----");
    const connection = joined("postgresql", "://user:password@db.public-host.net/app");
    const envSecret = joined("API", "_KEY=", "not-a-placeholder");

    expect(
      scanPublicFiles([
        file("z.txt", company),
        file("a.txt", `${localPath}\n${privateHost}\n${privateIp}\n${token}\n${jwt}\n${keyBlock}\n${connection}`),
        file(".env.public", envSecret),
      ]),
    ).toEqual([
      { line: 1, path: ".env.public", rule: "ENV_CREDENTIAL" },
      { line: 1, path: "a.txt", rule: "LOCAL_PATH" },
      { line: 2, path: "a.txt", rule: "PRIVATE_DNS" },
      { line: 3, path: "a.txt", rule: "PRIVATE_IP" },
      { line: 4, path: "a.txt", rule: "CREDENTIAL_TOKEN" },
      { line: 5, path: "a.txt", rule: "JWT" },
      { line: 6, path: "a.txt", rule: "PRIVATE_KEY" },
      { line: 9, path: "a.txt", rule: "CONNECTION_CREDENTIAL" },
      { line: 1, path: "z.txt", rule: "PROTECTED_IDENTIFIER" },
    ]);
  });

  it("does not treat loopback, documentation hosts, or placeholders as private", () => {
    expect(
      scanPublicFiles([
        file(
          "safe.md",
          "http://localhost:3000 http://127.0.0.1 https://example.test https://example.com placeholder-token",
        ),
      ]),
    ).toEqual([]);
  });

  it("keeps only public candidate paths outside private and generated boundaries", () => {
    expect(isPublicCandidatePath("README.md")).toBe(true);
    expect(isPublicCandidatePath("scripts/example.ts")).toBe(true);
    expect(isPublicCandidatePath(".agent-work/review.md")).toBe(true);
    expect(isPublicCandidatePath("reference-exports/public.md")).toBe(true);
    expect(isPublicCandidatePath(".superpowers/sdd/private.md")).toBe(false);
    expect(isPublicCandidatePath("node_modules/package/index.js")).toBe(false);
    expect(isPublicCandidatePath("dist/output.js")).toBe(false);
  });

  it("reports every protected identifier and keeps the adapter word Core-scoped", () => {
    const identifiers = [
      joined("ze", "iss"),
      joined("de", "c"),
      joined("m", "365"),
      joined("it", " ", "support"),
    ].join(" ");
    const adapter = joined("di", "fy");

    expect(
      scanPublicFiles([
        file("public.md", identifiers),
        file("packages/core/src/example.ts", adapter),
        file("docs/adapter.md", adapter),
      ]),
    ).toEqual([
      { line: 1, path: "packages/core/src/example.ts", rule: "CORE_PROVIDER_IDENTIFIER" },
      { line: 1, path: "public.md", rule: "PROTECTED_IDENTIFIER" },
      { line: 1, path: "public.md", rule: "PROTECTED_IDENTIFIER" },
      { line: 1, path: "public.md", rule: "PROTECTED_IDENTIFIER" },
      { line: 1, path: "public.md", rule: "PROTECTED_IDENTIFIER" },
    ]);
  });

  it("reports checkout paths, multi-label private hosts, prefixed env keys, and IPv6 private literals", () => {
    const checkout = joined("E:", "\\", "Develop", "\\", "workspace", "\\", "repo");
    const slashCheckout = joined("E:", "/", "Develop", "/", "workspace", "/repo");
    const internal = joined("api", ".", "service", ".", "internal");
    const intranet = joined("three", ".", "two", ".", "intranet");
    const ula = joined("fd12", ":", "3456", ":", "789a", "::1");
    const linkLocal = joined("[", "fe80", "::1234", "]");
    const env = joined("SERVICE", "_API", "_KEY=", "real-value");

    expect(
      scanPublicFiles([
        file("a.txt", `${checkout}\n${slashCheckout}\n${internal}\n${intranet}\n${ula}\n${linkLocal}`),
        file(".env.public", env),
      ]),
    ).toEqual([
      { line: 1, path: ".env.public", rule: "ENV_CREDENTIAL" },
      { line: 1, path: "a.txt", rule: "LOCAL_PATH" },
      { line: 2, path: "a.txt", rule: "LOCAL_PATH" },
      { line: 3, path: "a.txt", rule: "PRIVATE_DNS" },
      { line: 4, path: "a.txt", rule: "PRIVATE_DNS" },
      { line: 5, path: "a.txt", rule: "PRIVATE_IP" },
      { line: 6, path: "a.txt", rule: "PRIVATE_IP" },
    ]);
  });

  it("reports non-placeholder credentials even when their host is example or loopback", () => {
    const example = joined("postgresql", "://real-user:real-password@example.com/app");
    const loopback = joined("postgresql", "://real-user:real-password@127.0.0.1/app");

    expect(scanPublicFiles([file("connections.txt", `${example}\n${loopback}`)])).toEqual([
      { line: 1, path: "connections.txt", rule: "CONNECTION_CREDENTIAL" },
      { line: 2, path: "connections.txt", rule: "CONNECTION_CREDENTIAL" },
    ]);
  });

  it("reports provider-coupled Core identifiers without scanning adapter documentation", () => {
    const coupled = joined("di", "fy", "Client");
    const standalone = joined("di", "fy");

    expect(
      scanPublicFiles([
        file("packages/core/src/example.ts", coupled),
        file("docs/adapter.md", standalone),
      ]),
    ).toEqual([
      { line: 1, path: "packages/core/src/example.ts", rule: "CORE_PROVIDER_IDENTIFIER" },
    ]);
  });

  it("reports general absolute Windows, UNC, and Unix checkout paths", () => {
    const drive = joined("F:", "\\", "Projects", "\\", "repo");
    const unc = joined("\\", "\\", "server", "\\", "share", "\\", "repo");
    const unix = joined("/", "opt", "/", "workspace", "/repo");

    expect(scanPublicFiles([file("paths.txt", `${drive}\n${unc}\n${unix}`)])).toEqual([
      { line: 1, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 2, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 3, path: "paths.txt", rule: "LOCAL_PATH" },
    ]);
  });

  it("reports mixed template and real connection credentials", () => {
    const templateUser = joined("postgresql", "://", "${", "USER}", ":real-password@example.com/app");
    const templatePassword = joined("postgresql", "://real-user:", "${", "PASSWORD}", "@localhost/app");

    expect(
      scanPublicFiles([file("connections.txt", `${templateUser}\n${templatePassword}`)]),
    ).toEqual([
      { line: 1, path: "connections.txt", rule: "CONNECTION_CREDENTIAL" },
      { line: 2, path: "connections.txt", rule: "CONNECTION_CREDENTIAL" },
    ]);
  });

  it("reports trailing-compression private IPv6 literals", () => {
    const ula = joined("[", "fd00", "::", "]");
    const linkLocal = joined("[", "fe80", "::", "]");

    expect(scanPublicFiles([file("hosts.txt", `${ula}\n${linkLocal}`)])).toEqual([
      { line: 1, path: "hosts.txt", rule: "PRIVATE_IP" },
      { line: 2, path: "hosts.txt", rule: "PRIVATE_IP" },
    ]);
  });

  it("does not treat private-looking public DNS prefixes as private hosts", () => {
    const internal = joined("api", ".", "internal", ".example.com");
    const local = joined("api", ".", "local", ".example.com");

    expect(scanPublicFiles([file("public-hosts.txt", `${internal}\n${local}`)])).toEqual([]);
  });

  it("does not treat a private-looking IPv6 suffix inside a global literal as private", () => {
    const ulaSuffix = joined("2001", ":db8:", "fd00", "::1");
    const linkLocalSuffix = joined("2001", ":db8:", "fe80", "::1");

    expect(scanPublicFiles([file("global-hosts.txt", `${ulaSuffix}\n${linkLocalSuffix}`)])).toEqual([]);
  });

  it("reports prefixed camel-case and separator-delimited provider identifiers only in Core", () => {
    const camelCase = joined("create", "Di", "fy", "Client");
    const snakeCase = joined("create_", "di", "fy", "_client");

    expect(
      scanPublicFiles([
        file("packages/core/src/example.ts", `${camelCase}\n${snakeCase}`),
        file("docs/adapter.md", `${camelCase}\n${snakeCase}`),
      ]),
    ).toEqual([
      { line: 1, path: "packages/core/src/example.ts", rule: "CORE_PROVIDER_IDENTIFIER" },
      { line: 2, path: "packages/core/src/example.ts", rule: "CORE_PROVIDER_IDENTIFIER" },
    ]);
  });

  it("reports checkout roots and non-public URL paths while retaining public REST paths", () => {
    const driveRoot = joined("C:", "\\", "repo");
    const uncShareRoot = joined("\\", "\\", "server", "\\", "share");
    const workspaceRoot = joined("/", "workspace", "/repo");
    const publicApi = joined("/", "api", "/v1/chat");
    const publicWorkspaceUrl = joined(
      "https",
      "://example.com",
      "/",
      "workspace",
      "/repo",
    );
    const trailingDotPrivateUrl = joined(
      "https",
      "://api",
      ".",
      "internal",
      ".",
      "/",
      "workspace",
      "/repo",
    );
    const singleLabelUrl = joined(
      "https",
      "://dev",
      "server",
      "/",
      "workspace",
      "/repo",
    );
    const homeArpaUrl = joined(
      "https",
      "://api",
      ".home",
      ".arpa",
      "/",
      "workspace",
      "/repo",
    );
    const privateSuffixUrl = joined(
      "https",
      "://api",
      ".corp",
      "/",
      "workspace",
      "/repo",
    );
    const loopbackWorkspaceUrl = joined(
      "http",
      "://localhost",
      "/",
      "workspace",
      "/repo",
    );
    const documentationWorkspaceUrl = joined(
      "https",
      "://docs.example",
      ".test",
      "/",
      "workspace",
      "/repo",
    );
    const privateIpv4Url = joined(
      "https",
      "://10",
      ".12",
      ".0",
      ".8",
      "/",
      "workspace",
      "/repo",
    );
    const privateIpv6Url = joined(
      "https",
      "://[fd12",
      "::1]",
      "/",
      "workspace",
      "/repo",
    );
    const credentialWorkspaceUrl = joined(
      "https",
      "://real-user:real-password@example.com",
      "/",
      "workspace",
      "/repo",
    );
    const queryWorkspaceUrl = joined(
      "https",
      "://example.com/?next=",
      "/",
      "workspace",
      "/repo",
    );
    const fragmentWorkspaceUrl = joined(
      "https",
      "://example.com/#",
      "/",
      "workspace",
      "/repo",
    );
    const privatePublicSuffixUrl = joined(
      "https",
      "://api",
      ".blogspot",
      ".com",
      "/",
      "workspace",
      "/repo",
    );

    expect(
      scanPublicFiles([
        file(
          "paths.txt",
          `${driveRoot}\n${uncShareRoot}\n${workspaceRoot}\n${publicApi}\n${publicWorkspaceUrl}\n${trailingDotPrivateUrl}\n${singleLabelUrl}\n${homeArpaUrl}\n${privateSuffixUrl}\n${loopbackWorkspaceUrl}\n${documentationWorkspaceUrl}\n${privateIpv4Url}\n${privateIpv6Url}\n${credentialWorkspaceUrl}\n${queryWorkspaceUrl}\n${fragmentWorkspaceUrl}\n${privatePublicSuffixUrl}`,
        ),
      ]),
    ).toEqual([
      { line: 1, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 2, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 3, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 6, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 7, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 8, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 9, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 12, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 12, path: "paths.txt", rule: "PRIVATE_IP" },
      { line: 13, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 13, path: "paths.txt", rule: "PRIVATE_IP" },
      { line: 14, path: "paths.txt", rule: "CONNECTION_CREDENTIAL" },
      { line: 15, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 16, path: "paths.txt", rule: "LOCAL_PATH" },
      { line: 17, path: "paths.txt", rule: "LOCAL_PATH" },
    ]);
  });

  it("reports connection credentials with a real prefix before a template marker", () => {
    const username = joined("real-", "${", "USER}");
    const connection = joined("postgresql", "://", username, ":placeholder@example.com/app");

    expect(scanPublicFiles([file("connections.txt", connection)])).toEqual([
      { line: 1, path: "connections.txt", rule: "CONNECTION_CREDENTIAL" },
    ]);
  });

  it("does not classify MAC-style or malformed colon tokens as private IPv6", () => {
    const mac = joined("fd", ":00:ab:cd:ef:12");
    const incomplete = joined("fd00", ":1234:5678");
    const overlong = joined("fd00", ":1:2:3:4:5:6:7:8");

    expect(scanPublicFiles([file("tokens.txt", `${mac}\n${incomplete}\n${overlong}`)])).toEqual([]);
  });
});

describe("open-source scrub CLI", () => {
  it("scans an unignored public candidate and never discloses its match", async () => {
    const secret = joined("sk", "-", "directOutputSecret", "12345678");
    const publicFixturePath = join(
      process.cwd(),
      `.scrub-cli-${process.pid}-fixture.txt`,
    );
    repositoryFixturePaths.push(publicFixturePath);
    expect(scanPublicFiles([file("public.txt", secret)])).toEqual([
      { line: 1, path: "public.txt", rule: "CREDENTIAL_TOKEN" },
    ]);
    await writeFile(publicFixturePath, secret, "utf8");

    const result = spawnSync(process.execPath, [tsxCli, scrubScript], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}|${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(
      `CREDENTIAL_TOKEN ${publicFixturePath.split(/[\\/]/u).at(-1)}:1`,
    );
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(process.cwd());
  });

  it("reports the real repository candidate scan as clean", () => {
    const result = spawnSync(process.execPath, [tsxCli, scrubScript], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("open-source scrub: clean");
    expect(result.stderr).toBe("");
  });

  it("scans a committed tracked candidate after its staged diff is empty", async () => {
    const secret = joined("sk", "-", "committedFixtureSecret", "12345678");
    const root = await createCommittedFixture(".agent-work/tracked.txt", secret);

    const result = runScrub(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CREDENTIAL_TOKEN .agent-work/tracked.txt:1");
    expect(result.stderr).not.toContain(secret);
  });

  it("fails closed when a committed candidate cannot be read", async () => {
    const root = await createCommittedFixture("missing.txt", "safe");
    await unlink(join(root, "missing.txt"));

    const result = runScrub(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CANDIDATE_READ_ERROR missing.txt:0");
    expect(result.stderr).not.toContain(root);
  });
});
