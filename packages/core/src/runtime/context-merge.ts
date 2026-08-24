import type { ContextPatch, SkeinContext } from "../context/context.js";
import {
  createContextValidator,
  type ContextValidator,
} from "../context/context-validator.js";

import { normalizeContextPatch } from "./orchestration-result.js";

const defaultContextValidator = createContextValidator();

export const createDefaultSkeinContext = (revision = 0): SkeinContext => ({
  version: "1.0",
  revision,
  conversation: {},
  workflow: { state: {} },
  runtime: {},
});

export const mergeContextPatch = (
  current: SkeinContext,
  patch: ContextPatch | undefined,
  turnId: string,
  updatedAt: string,
  contextValidator: ContextValidator = defaultContextValidator,
): SkeinContext => {
  const normalizedPatch =
    patch === undefined
      ? undefined
      : normalizeContextPatch(patch, contextValidator);
  const conversation = structuredClone(current.conversation);
  const conversationPatch = normalizedPatch?.conversation;
  if (conversationPatch?.topic !== undefined) {
    conversation.topic = conversationPatch.topic as string;
  }
  if (conversationPatch?.language !== undefined) {
    conversation.language = conversationPatch.language as string;
  }

  const merged: SkeinContext = {
    version: "1.0",
    revision: current.revision + 1,
    conversation,
    workflow: {
      state: {
        ...structuredClone(current.workflow.state),
        ...structuredClone(normalizedPatch?.workflowState ?? {}),
      },
    },
    runtime: {
      lastTurnId: turnId,
      updatedAt,
    },
  };
  return contextValidator.validateContext(merged);
};
