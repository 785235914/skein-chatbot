import { z } from "zod";

import {
  ChatResponseSchema,
  PublicErrorSchema,
  SourceSchema,
} from "./public.js";

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.started") }).strict(),
  z
    .object({
      type: z.literal("status.changed"),
      status: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({ type: z.literal("assistant.delta"), text: z.string() })
    .strict(),
  z.object({ type: z.literal("source.added"), source: SourceSchema }).strict(),
  z
    .object({
      type: z.literal("turn.completed"),
      result: ChatResponseSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("turn.failed"), error: PublicErrorSchema })
    .strict(),
]);

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const encodeSseEvent = (event: RuntimeEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
