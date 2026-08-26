import { readFile } from "node:fs/promises";
import path from "node:path";

import { isRuntimeError } from "@skein-chatbot/core";

import type { ApiRuntime } from "../apps/api/src/api-runtime.js";
import { createDefaultApiRuntime } from "../apps/api/src/composition.js";
import { loadApiConfig } from "../apps/api/src/config.js";

const parseEnvironmentLine = (
  line: string,
): readonly [string, string] | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
    trimmed,
  );
  if (match === null) {
    return undefined;
  }
  const key = match[1];
  let value = match[2];
  if (key === undefined || value === undefined) {
    return undefined;
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
};

const localEnvironmentCandidates = (): string[] => {
  const requested = process.env.SKEIN_LOCAL_ENV_FILE;
  if (requested !== undefined && requested.length > 0) {
    return [path.resolve(process.cwd(), requested)];
  }
  return [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "apps", "api", ".env.local"),
  ];
};

const loadLocalEnvironment = async (): Promise<string | undefined> => {
  for (const candidate of localEnvironmentCandidates()) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    for (const line of text.split(/\r?\n/u)) {
      const entry = parseEnvironmentLine(line);
      if (
        entry !== undefined &&
        (process.env[entry[0]] === undefined ||
          process.env[entry[0]]?.length === 0)
      ) {
        process.env[entry[0]] = entry[1];
      }
    }
    return candidate;
  }
  return undefined;
};

const notRun = (reason: string): void => {
  console.log(`Dify restart smoke: NOT RUN (${reason}).`);
};

const closeRuntime = async (runtime: ApiRuntime | undefined): Promise<void> => {
  try {
    await runtime?.close?.();
  } catch {
    // Cleanup failures must not serialize driver or credential details.
  }
};

const main = async (): Promise<void> => {
  const startedAt = performance.now();
  let firstRuntime: ApiRuntime | undefined;
  let secondRuntime: ApiRuntime | undefined;
  try {
    const environmentFile = await loadLocalEnvironment();
    if (environmentFile === undefined) {
      notRun(".env.local not found");
      return;
    }

    const missing = [
      ...(process.env.DIFY_BASE_URL === undefined ||
      process.env.DIFY_BASE_URL.length === 0
        ? ["DIFY_BASE_URL"]
        : []),
      ...(process.env.DIFY_API_KEY === undefined ||
      process.env.DIFY_API_KEY.length === 0
        ? ["DIFY_API_KEY"]
        : []),
      ...(process.env.SESSION_RESUME_SECRET === undefined ||
      process.env.SESSION_RESUME_SECRET.length === 0
        ? ["SESSION_RESUME_SECRET"]
        : []),
    ];
    if (missing.length > 0) {
      notRun(`missing ${missing.join(", ")}`);
      return;
    }

    const configuredProfileDirectory =
      process.env.DIFY_PROFILE_DIRECTORY;
    const environment = {
      ...process.env,
      ORCHESTRATOR_PROVIDER: "dify",
      DATABASE_URL: "",
      LOG_LEVEL: "silent",
      ...(configuredProfileDirectory === undefined
        ? {}
        : {
            DIFY_PROFILE_DIRECTORY: path.isAbsolute(
              configuredProfileDirectory,
            )
              ? configuredProfileDirectory
              : path.resolve(
                  path.dirname(environmentFile),
                  configuredProfileDirectory,
                ),
          }),
    };
    const config = loadApiConfig(environment);
    const user = { userId: `smoke-${Date.now().toString(36)}` };

    firstRuntime = await createDefaultApiRuntime(config);
    const initial = await firstRuntime.chat(
      {
        message: "Summarize the general capabilities available in this chat.",
        mode: "quick",
        user,
      },
      AbortSignal.timeout(60_000),
    );
    if (initial.resumeToken === undefined) {
      throw new Error("Resume capability was unavailable.");
    }
    await closeRuntime(firstRuntime);
    firstRuntime = undefined;

    secondRuntime = await createDefaultApiRuntime(config);
    const restored = await secondRuntime.resumeSession(
      initial.resumeToken,
      user,
      AbortSignal.timeout(60_000),
    );
    if (restored.messages.length < 2) {
      throw new Error("Provider history was not restored.");
    }
    await secondRuntime.chat(
      {
        sessionId: restored.session.id,
        message: "Continue with one concise, general usage tip.",
        mode: "quick",
        user,
      },
      AbortSignal.timeout(60_000),
    );

    console.log(
      JSON.stringify({
        smoke: "dify-restart-resume",
        status: "PASS",
        latencyMs: Math.round(performance.now() - startedAt),
        initialTokenIssued: true,
        restored: true,
        restoredMessageCount: restored.messages.length,
        continued: true,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        smoke: "dify-restart-resume",
        status: "FAIL",
        latencyMs: Math.round(performance.now() - startedAt),
        errorCode: isRuntimeError(error) ? error.code : "INTERNAL_ERROR",
      }),
    );
    process.exitCode = 1;
  } finally {
    await closeRuntime(firstRuntime);
    await closeRuntime(secondRuntime);
  }
};

await main();
