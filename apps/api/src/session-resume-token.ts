import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

import type {
  ResumeTokenCodec,
  SessionResumeClaims,
} from "@skein-chatbot/core";

const ALGORITHM = "aes-256-gcm";
const AUTHENTICATED_HEADER = "skein.resume.v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAXIMUM_TOKEN_CHARACTERS = 8_192;

const SessionResumeClaimsSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(128),
    userId: z.string().min(1).max(512),
    provider: z.string().min(1).max(128),
    providerKey: z.string().min(1).max(512),
    externalConversationId: z.string().min(1).max(2_048),
    issuedAt: z.string().datetime(),
  })
  .strict();

const invalidToken = (): Error =>
  new Error("The session resume token is invalid.");

const decodeSegment = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidToken();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw invalidToken();
  }
  return decoded;
};

export const createEncryptedResumeTokenCodec = (
  secret: Uint8Array,
): ResumeTokenCodec => {
  if (secret.byteLength !== 32) {
    throw new RangeError(
      "The session resume secret must contain exactly 32 bytes.",
    );
  }
  const key = Buffer.from(secret);
  const additionalData = Buffer.from(AUTHENTICATED_HEADER, "utf8");

  return {
    encode(claims: SessionResumeClaims): string {
      const parsed = SessionResumeClaimsSchema.safeParse(claims);
      if (!parsed.success) {
        throw invalidToken();
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(additionalData);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(parsed.data), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return [
        AUTHENTICATED_HEADER,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    },

    decode(token: string): SessionResumeClaims {
      try {
        const prefix = `${AUTHENTICATED_HEADER}.`;
        if (
          token.length > MAXIMUM_TOKEN_CHARACTERS ||
          !token.startsWith(prefix)
        ) {
          throw invalidToken();
        }
        const segments = token.slice(prefix.length).split(".");
        if (segments.length !== 3) {
          throw invalidToken();
        }
        const [ivSegment, ciphertextSegment, tagSegment] = segments;
        const iv = decodeSegment(ivSegment ?? "");
        const ciphertext = decodeSegment(ciphertextSegment ?? "");
        const tag = decodeSegment(tagSegment ?? "");
        if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
          throw invalidToken();
        }

        const decipher = createDecipheriv(ALGORITHM, key, iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(additionalData);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const value: unknown = JSON.parse(plaintext.toString("utf8"));
        return SessionResumeClaimsSchema.parse(value);
      } catch {
        throw invalidToken();
      }
    },
  };
};
