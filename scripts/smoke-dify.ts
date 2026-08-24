import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createDifyBusinessOrchestrator,
  loadDifyProfile,
} from "@skein-chatbot/adapter-dify";
import { isRuntimeError, type OrchestrationInput } from "@skein-chatbot/core";

const ENV_FILE = path.resolve(process.cwd(), ".env.local");

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

const loadLocalEnvironment = async (): Promise<boolean> => {
  let text: string;
  try {
    text = await readFile(ENV_FILE, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  for (const line of text.split(/\r?\n/u)) {
    const entry = parseEnvironmentLine(line);
    if (entry !== undefined && process.env[entry[0]] === undefined) {
      process.env[entry[0]] = entry[1];
    }
  }
  return true;
};

const notRun = (reason: string): void => {
  console.log(`Dify smoke: NOT RUN (${reason}).`);
};

const main = async (): Promise<void> => {
  const startedAt = performance.now();
  try {
    if (!(await loadLocalEnvironment())) {
      notRun(".env.local not found");
      return;
    }

    const baseUrl = process.env.DIFY_BASE_URL;
    const apiKey = process.env.DIFY_API_KEY;
    const profileName = process.env.DIFY_PROFILE ?? "default";
    const profileDirectory = process.env.DIFY_PROFILE_DIRECTORY;
    const missing = [
      ...(baseUrl === undefined || baseUrl.length === 0
        ? ["DIFY_BASE_URL"]
        : []),
      ...(apiKey === undefined || apiKey.length === 0 ? ["DIFY_API_KEY"] : []),
    ];
    if (missing.length > 0) {
      notRun(`missing ${missing.join(", ")}`);
      return;
    }
    if (baseUrl === undefined || apiKey === undefined) {
      notRun("missing required provider configuration");
      return;
    }

    const profile = await loadDifyProfile({
      name: profileName,
      ...(profileDirectory === undefined ? {} : { directory: profileDirectory }),
    });
    const orchestrator = createDifyBusinessOrchestrator({
      baseUrl,
      apiKey,
      profile,
    });
    const input: OrchestrationInput = {
      traceId: "smoke-trace",
      turnId: "smoke-turn",
      sessionId: `smoke-${Date.now().toString(36)}`,
      query:
        "Briefly describe the kinds of questions this assistant can answer.",
      mode: "QUICK",
      context: {
        version: "1.0",
        revision: 0,
        conversation: {},
        workflow: { state: {} },
        runtime: {},
      },
      memory: { recentMessages: [] },
      user: { userId: `smoke-${Date.now().toString(36)}` },
    };
    const result = await orchestrator.execute(input, AbortSignal.timeout(60_000));
    console.log(
      JSON.stringify({
        smoke: "dify",
        status: "PASS",
        latencyMs: Math.round(performance.now() - startedAt),
        resultStatus: result.status,
        hasConversationId: result.providerConversationId !== undefined,
        sourceCount: result.sources.length,
        hasFollowUpQuestion: result.followUpQuestion !== undefined,
        hasContextPatch: result.contextPatch !== undefined,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        smoke: "dify",
        status: "FAIL",
        latencyMs: Math.round(performance.now() - startedAt),
        errorCode: isRuntimeError(error) ? error.code : "INTERNAL_ERROR",
      }),
    );
    process.exitCode = 1;
  }
};

await main();
