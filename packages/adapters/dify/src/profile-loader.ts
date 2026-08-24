import { readFile } from "node:fs/promises";
import path from "node:path";

import { isAlias, parseDocument, visit } from "yaml";
import type { ZodIssue } from "zod";

import { DifyProfileSchema } from "./profile-schema.js";
import type { DifyProfile, LoadDifyProfileOptions } from "./types.js";

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_PROFILE_DEPTH = 24;
const MAX_PROFILE_NODES = 2_048;
const MAX_PROFILE_ARRAY_LENGTH = 128;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class DifyProfileError extends Error {
  readonly issues: readonly Pick<ZodIssue, "code" | "path" | "message">[];

  constructor(
    message: string,
    options: {
      cause?: unknown;
      issues?: readonly Pick<ZodIssue, "code" | "path" | "message">[];
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DifyProfileError";
    this.issues = options.issues ?? [];
  }
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
};

const assertBoundedValue = (
  value: unknown,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): void => {
  state.nodes += 1;
  if (state.nodes > MAX_PROFILE_NODES || depth > MAX_PROFILE_DEPTH) {
    throw new DifyProfileError("Dify profile exceeds structural limits.");
  }
  if (typeof value === "string" && value.length > MAX_PROFILE_BYTES) {
    throw new DifyProfileError("Dify profile contains an oversized value.");
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PROFILE_ARRAY_LENGTH) {
      throw new DifyProfileError("Dify profile contains an oversized array.");
    }
    for (const child of value) {
      assertBoundedValue(child, depth + 1, state);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DifyProfileError("Dify profile contains a reserved key.");
    }
    assertBoundedValue(child, depth + 1, state);
  }
};

export const parseDifyProfile = (
  yaml: string,
  source = "Dify profile",
): DifyProfile => {
  if (Buffer.byteLength(yaml, "utf8") > MAX_PROFILE_BYTES) {
    throw new DifyProfileError(`${source} exceeds the profile size limit.`);
  }

  let raw: unknown;
  try {
    const document = parseDocument(yaml, {
      merge: false,
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new DifyProfileError(`${source} is not valid YAML.`, {
        cause: document.errors[0],
      });
    }
    let containsAlias = false;
    visit(document, {
      Node(_key, node) {
        if (isAlias(node)) {
          containsAlias = true;
          return visit.BREAK;
        }
        return undefined;
      },
    });
    if (containsAlias) {
      throw new DifyProfileError(`${source} may not contain YAML aliases.`);
    }
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof DifyProfileError) {
      throw error;
    }
    throw new DifyProfileError(`${source} is not valid YAML.`, {
      cause: error,
    });
  }

  assertBoundedValue(raw);
  const parsed = DifyProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DifyProfileError(`${source} does not match the Dify profile schema.`, {
      cause: parsed.error,
      issues: parsed.error.issues.map(({ code, path: issuePath, message }) => ({
        code,
        path: issuePath,
        message,
      })),
    });
  }
  return deepFreeze(parsed.data) as DifyProfile;
};

export const loadDifyProfileFile = async (
  filePath: string,
): Promise<DifyProfile> => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".yaml" && extension !== ".yml") {
    throw new DifyProfileError("Dify profile file must use .yaml or .yml.");
  }

  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new DifyProfileError("Dify profile file could not be read.", {
      cause: error,
    });
  }
  return parseDifyProfile(contents, path.basename(filePath));
};

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const loadDifyProfile = async (
  options: LoadDifyProfileOptions,
): Promise<DifyProfile> => {
  if (!PROFILE_NAME_PATTERN.test(options.name)) {
    throw new DifyProfileError("Dify profile name is invalid.");
  }
  const directory = path.resolve(
    options.directory ?? path.join(process.cwd(), "config", "dify-profiles"),
  );
  const filePath = path.resolve(directory, `${options.name}.yaml`);
  if (path.dirname(filePath) !== directory) {
    throw new DifyProfileError("Dify profile path is outside its directory.");
  }
  return loadDifyProfileFile(filePath);
};
