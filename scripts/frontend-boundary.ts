import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "node_modules",
  "reference-exports",
]);

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const DEEPSEEK_UI_SHELL_PACKAGES = [
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

const FORBIDDEN_REFERENCES = [
  "@skein-chatbot/demo-web",
  "apps/demo-web",
  "examples/deepseek-ui",
  ...DEEPSEEK_UI_SHELL_PACKAGES,
];

const FORBIDDEN_REFERENCE_SET = new Set(FORBIDDEN_REFERENCES);

export interface FrontendBoundaryViolation {
  kind: "dependency" | "source";
  path: string;
  reference: string;
}

export interface FrontendBoundaryResult {
  violations: FrontendBoundaryViolation[];
}

type PackageManifest = Record<string, unknown>;

const toRepositoryPath = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

const referencesIn = (text: string): string[] => {
  const matches: Array<{ index: number; reference: string }> = [];
  for (const reference of FORBIDDEN_REFERENCES) {
    const pattern = new RegExp(
      `${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      matches.push({ index: match.index, reference });
    }
  }
  return matches
    .sort((left, right) => left.index - right.index)
    .map((match) => match.reference)
    .filter((reference, index, all) => all.indexOf(reference) === index);
};

const readDirectories = (path: string): string[] => {
  if (!existsSync(path)) {
    return [];
  }
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name))
    .map((entry) => join(path, entry.name))
    .sort();
};

const collectPackageManifests = (packagesRoot: string): string[] => {
  const manifests: string[] = [];
  const visit = (directory: string): void => {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      manifests.push(manifest);
    }
    for (const child of readDirectories(directory)) {
      visit(child);
    }
  };
  visit(packagesRoot);
  return manifests.sort();
};

const collectSourceFiles = (sourceRoot: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          visit(path);
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(`.${entry.name.split(".").pop()}`)) {
        files.push(path);
      }
    }
  };
  if (existsSync(sourceRoot)) {
    visit(sourceRoot);
  }
  return files.sort();
};

const collectManifestDependencyViolations = (
  root: string,
  manifestPath: string,
): FrontendBoundaryViolation[] => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const path = toRepositoryPath(root, manifestPath);
  const violations: FrontendBoundaryViolation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) {
      continue;
    }
    for (const dependency of Object.keys(dependencies as Record<string, unknown>)) {
      if (
        FORBIDDEN_REFERENCE_SET.has(dependency)
      ) {
        violations.push({ kind: "dependency", path, reference: dependency });
      }
    }
  }
  return violations;
};

/**
 * Inspects only non-frontend package manifests and their source roots for
 * forbidden frontend coupling. Diagnostics intentionally never include file contents.
 */
export const verifyFrontendBoundary = (
  repositoryRoot: string,
): FrontendBoundaryResult => {
  const root = resolve(repositoryRoot);
  const manifestPaths = [join(root, "apps", "api", "package.json")]
    .filter(existsSync)
    .concat(collectPackageManifests(join(root, "packages")));
  const violations = manifestPaths.flatMap((manifestPath) => [
    ...collectManifestDependencyViolations(root, manifestPath),
    ...collectSourceFiles(join(manifestPath, "..", "src")).flatMap((sourcePath) =>
      referencesIn(readFileSync(sourcePath, "utf8")).map((reference) => ({
        kind: "source" as const,
        path: toRepositoryPath(root, sourcePath),
        reference,
      })),
    ),
  ]);
  return { violations };
};

const isDirectInvocation = (): boolean => {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && resolve(scriptPath) === fileURLToPath(import.meta.url);
};

if (isDirectInvocation()) {
  const result = verifyFrontendBoundary(process.cwd());
  for (const violation of result.violations) {
    console.error(
      `${violation.kind}: ${violation.path} references ${violation.reference}`,
    );
  }
  if (result.violations.length === 0) {
    console.log("frontend boundary: clear");
  } else {
    process.exitCode = 1;
  }
}
