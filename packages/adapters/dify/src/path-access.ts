import type { DifyPathSelection } from "./types.js";
import { isSafeDifyPath } from "./profile-schema.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getDifyPath = (value: unknown, path: string): unknown => {
  if (!isSafeDifyPath(path)) {
    return undefined;
  }

  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

export const getFirstDifyPath = (
  value: unknown,
  selection: DifyPathSelection,
): unknown => {
  const paths = typeof selection === "string" ? [selection] : selection;
  for (const path of paths) {
    const selected = getDifyPath(value, path);
    if (selected !== undefined && selected !== null) {
      return selected;
    }
  }
  return undefined;
};

export const isDifyRecord = isRecord;
