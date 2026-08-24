import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { verifyFrontendBoundary } from "./frontend-boundary.js";

const fixtureRoots: string[] = [];
const deepSeekShellPackages = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/cordis-plugin-group",
  "@deepseek-ai/cordis-plugin-loader",
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-schema-form",
  "@deepseek-ai/dsh-client-test-runtime",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-web",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-pwsh-local",
  "@deepseek-ai/dsh-web-frontend",
];
const boundaryScriptPath = fileURLToPath(
  new URL("./frontend-boundary.ts", import.meta.url),
);
const tsxCliPath = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

const writeFixture = async (
  files: Record<string, string>,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "skein-frontend-boundary-"));
  fixtureRoots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const target = join(root, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("verifyFrontendBoundary", () => {
  test("keeps a clean controlled runtime/API graph and the real non-frontend graph clear", async () => {
    const fixtureRoot = await writeFixture({
      "apps/api/package.json": JSON.stringify({
        name: "@fixture/api",
        dependencies: { fastify: "1.0.0" },
      }),
      "apps/api/src/server.ts": 'import Fastify from "fastify";\nvoid Fastify;\n',
      "packages/core/package.json": JSON.stringify({
        name: "@fixture/core",
      }),
      "packages/core/src/runtime.ts": "export const runtime = true;\n",
    });

    expect(verifyFrontendBoundary(fixtureRoot).violations).toEqual([]);
    expect(verifyFrontendBoundary(process.cwd()).violations).toEqual([]);
  });

  test("traverses nested package manifests and reports every evidenced shell family", async () => {
    const fixtureRoot = await writeFixture({
      "apps/api/package.json": JSON.stringify({
        name: "@fixture/api",
      }),
      "apps/api/src/server.ts": [
        'export const client = "../../apps/demo-web";',
        'export const bridge = "examples/deepseek-ui";',
        'import "@deepseek-ai/dsh-client-ui-theme";',
      ].join("\n"),
      "packages/adapters/shell/package.json": JSON.stringify({
        name: "@fixture/shell",
        dependencies: Object.fromEntries([
          ["@skein-chatbot/demo-web", "workspace:*"],
          ...deepSeekShellPackages.map((dependency) => [dependency, "1.0.0"]),
        ]),
      }),
    });

    const violations = verifyFrontendBoundary(fixtureRoot).violations;

    expect(violations).toHaveLength(deepSeekShellPackages.length + 4);
    expect(violations.map((violation) => violation.path)).toEqual([
      "apps/api/src/server.ts",
      "apps/api/src/server.ts",
      "apps/api/src/server.ts",
      ...Array(deepSeekShellPackages.length + 1).fill(
        "packages/adapters/shell/package.json",
      ),
    ]);
    expect(violations.map((violation) => violation.reference)).toEqual([
      "apps/demo-web",
      "examples/deepseek-ui",
      "@deepseek-ai/dsh-client-ui-theme",
      "@skein-chatbot/demo-web",
      ...deepSeekShellPackages,
    ]);
    expect(violations.every((violation) => !violation.path.includes(".."))).toBe(
      true,
    );
  });

  test("excludes reachable package and source subtrees", async () => {
    const fixtureRoot = await writeFixture({
      "apps/api/package.json": JSON.stringify({ name: "@fixture/api" }),
      "apps/api/src/server.ts": "export const server = true;\n",
      "packages/.git/package.json": JSON.stringify({
        dependencies: { "@skein-chatbot/demo-web": "workspace:*" },
      }),
      "packages/reference-exports/package.json": JSON.stringify({
        dependencies: { "@skein-chatbot/demo-web": "workspace:*" },
      }),
      "packages/core/package.json": JSON.stringify({ name: "@fixture/core" }),
      "packages/core/src/runtime.ts": "export const runtime = true;\n",
      "packages/core/src/dist/leak.ts": 'import "@deepseek-ai/dsh-client-web";\n',
      "packages/core/src/node_modules/leak.ts": 'import "@deepseek-ai/dsh-client-web";\n',
    });

    expect(verifyFrontendBoundary(fixtureRoot).violations).toEqual([]);
  });

  test("exits nonzero from the direct CLI without printing fixture contents", async () => {
    const fixtureRoot = await writeFixture({
      "apps/api/package.json": JSON.stringify({
        dependencies: { "@skein-chatbot/demo-web": "workspace:*" },
      }),
    });

    const result = spawnSync(process.execPath, [tsxCliPath, boundaryScriptPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "dependency: apps/api/package.json references @skein-chatbot/demo-web",
    );
    expect(result.stderr).not.toContain(fixtureRoot);
    expect(result.stderr).not.toContain("workspace:*");
  });
});
