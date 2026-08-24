import { describe, expect, it } from "vitest";

import {
  ChatRequestSchema,
  ChatResponseSchema,
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
});
