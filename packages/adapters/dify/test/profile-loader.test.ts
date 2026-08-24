import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DifyProfileError,
  loadDifyProfile,
  loadDifyProfileFile,
  parseDifyProfile,
} from "../src/index.js";
import { getDifyPath } from "../src/path-access.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const minimalProfile = `
name: profile-a
request:
  context: context_payload
  mode: mode_value
modeMapping:
  QUICK: FAST
  DEEP: THOROUGH
response:
  answer: output.text
  conversationId: conversation_id
source:
  title: title
stream:
  statusMapping:
    workflow_started: Processing request
transport:
  executeResponseMode: blocking
`;

describe("Dify profile loader", () => {
  it("parses and deeply freezes a Zod-validated YAML profile", () => {
    const profile = parseDifyProfile(minimalProfile);
    expect(profile).toMatchObject({
      name: "profile-a",
      request: { context: "context_payload", mode: "mode_value" },
      response: {
        answer: "output.text",
        sources: "metadata.retriever_resources",
      },
      stream: {
        textEvents: ["message", "agent_message"],
        terminalEvents: ["message_end"],
      },
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.stream.statusMapping)).toBe(true);
  });

  it("loads a selected profile from a bounded directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "skein-profile-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "profile-a.yaml"), minimalProfile);

    await expect(
      loadDifyProfile({ name: "profile-a", directory }),
    ).resolves.toMatchObject({ name: "profile-a" });
    await expect(
      loadDifyProfile({ name: "../outside", directory }),
    ).rejects.toBeInstanceOf(DifyProfileError);
  });

  it("fails startup for malformed, unsafe, duplicate, and unknown profile fields", async () => {
    for (const invalid of [
      "name: [",
      `${minimalProfile}\nunknown: true\n`,
      minimalProfile.replace("output.text", "output.__proto__.text"),
      minimalProfile.replace(
        "mode: mode_value",
        "mode: context_payload",
      ),
      minimalProfile.replace(
        "workflow_started: Processing request",
        "workflow_started: Provider node detail",
      ),
      `${minimalProfile}\nalias: &value x\ncopy: *value\n`,
    ]) {
      expect(() => parseDifyProfile(invalid)).toThrow(DifyProfileError);
    }

    const directory = await mkdtemp(path.join(tmpdir(), "skein-profile-"));
    temporaryDirectories.push(directory);
    const wrongExtension = path.join(directory, "profile.json");
    await writeFile(wrongExtension, "{}");
    await expect(loadDifyProfileFile(wrongExtension)).rejects.toBeInstanceOf(
      DifyProfileError,
    );
  });

  it("accesses only bounded own-property paths", () => {
    const inherited = Object.create({ hidden: { value: "no" } }) as Record<
      string,
      unknown
    >;
    inherited.visible = { value: "yes" };
    expect(getDifyPath(inherited, "visible.value")).toBe("yes");
    expect(getDifyPath(inherited, "hidden.value")).toBeUndefined();
    expect(getDifyPath(inherited, "__proto__.hidden")).toBeUndefined();
  });
});
