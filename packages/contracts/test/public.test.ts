import { describe, expect, it } from "vitest";

import {
  ChatRequestSchema,
  ChatResponseSchema,
  ResumeSessionRequestSchema,
  ResumeSessionResponseSchema,
  RuntimeEventSchema,
} from "../src/index.js";

describe("public contracts", () => {
  it("accepts the canonical chat request", () => {
    expect(
      ChatRequestSchema.parse({
        sessionId: "session-1",
        message: "Hello",
        mode: "quick",
        metadata: {},
      }),
    ).toEqual({
      sessionId: "session-1",
      message: "Hello",
      mode: "quick",
      metadata: {},
    });
  });

  it("rejects provider-specific public request values", () => {
    expect(() =>
      ChatRequestSchema.parse({ message: "Hello", mode: "WORKFLOW" }),
    ).toThrow();
  });

  it("requires canonical result fields on completion events", () => {
    expect(
      RuntimeEventSchema.parse({
        type: "turn.completed",
        result: ChatResponseSchema.parse({
          sessionId: "session-1",
          turnId: "turn-1",
          answer: "Done",
          status: "ANSWER",
          sources: [],
          followUpQuestion: "",
          followUpGuidance: "",
          metadata: {},
        }),
      }),
    ).toMatchObject({ type: "turn.completed" });
  });

  it("accepts an opaque session resume token on chat results", () => {
    expect(
      ChatResponseSchema.parse({
        sessionId: "session-1",
        turnId: "turn-1",
        answer: "Done",
        status: "ANSWER",
        sources: [],
        followUpQuestion: "",
        followUpGuidance: "",
        metadata: {},
        resumeToken: "opaque-skein-token",
      }),
    ).toMatchObject({ resumeToken: "opaque-skein-token" });
  });

  it("validates provider-neutral session resume envelopes", () => {
    expect(
      ResumeSessionRequestSchema.parse({ resumeToken: "opaque-skein-token" }),
    ).toEqual({ resumeToken: "opaque-skein-token" });
    expect(
      ResumeSessionResponseSchema.parse({
        session: {
          id: "session-1",
          userId: "user-1",
          status: "ACTIVE",
          revision: 0,
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:01.000Z",
          lastActiveAt: "2026-08-25T00:00:01.000Z",
        },
        messages: [],
        resumeToken: "refreshed-token",
      }),
    ).toMatchObject({ resumeToken: "refreshed-token" });
  });
});
