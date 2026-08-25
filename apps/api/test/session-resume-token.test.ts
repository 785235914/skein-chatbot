import { createCipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SessionResumeClaims } from "@skein-chatbot/core";

import { createEncryptedResumeTokenCodec } from "../src/session-resume-token.js";

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const claims = (): SessionResumeClaims => ({
  version: 1,
  sessionId: "session-1",
  userId: "user-1",
  provider: "provider-1",
  providerKey: "profile-1",
  externalConversationId: "external-conversation-1",
  issuedAt: "2026-08-25T00:00:00.000Z",
});

const authenticatedTokenFor = (
  secret: Uint8Array,
  payload: unknown,
): string => {
  const header = "skein.resume.v1";
  const iv = new Uint8Array(12).fill(9);
  const cipher = createCipheriv("aes-256-gcm", secret, iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(header, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    header,
    Buffer.from(iv).toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
};

describe("encrypted session resume tokens", () => {
  it("round-trips across codec instances without exposing provider identity", () => {
    const first = createEncryptedResumeTokenCodec(key(1));
    const second = createEncryptedResumeTokenCodec(key(1));
    const value = claims();

    const token = first.encode(value);

    expect(token).not.toContain(value.externalConversationId);
    expect(token).not.toContain(value.userId);
    expect(second.decode(token)).toEqual(value);
  });

  it("rejects tampering, wrong secrets, and malformed claims identically", () => {
    const codec = createEncryptedResumeTokenCodec(key(2));
    const token = codec.encode(claims());
    const wrongCodec = createEncryptedResumeTokenCodec(key(3));
    const invalidTokens = [
      `${token}x`,
      token.replace(/.$/u, (value) => (value === "a" ? "b" : "a")),
      "not-a-resume-token",
      authenticatedTokenFor(key(2), { ...claims(), version: 2 }),
    ];

    for (const invalidToken of invalidTokens) {
      expect(() => codec.decode(invalidToken)).toThrow(
        "The session resume token is invalid.",
      );
    }
    expect(() => wrongCodec.decode(token)).toThrow(
      "The session resume token is invalid.",
    );
  });

  it("requires an exact 32-byte AES key", () => {
    expect(() => createEncryptedResumeTokenCodec(new Uint8Array(31))).toThrow(
      "exactly 32 bytes",
    );
    expect(() => createEncryptedResumeTokenCodec(new Uint8Array(33))).toThrow(
      "exactly 32 bytes",
    );
  });
});
