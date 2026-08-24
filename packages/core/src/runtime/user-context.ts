/** Opaque, provider-neutral user information available during a turn. */
export interface RuntimeUserContext {
  userId: string;
  metadata?: Record<string, unknown>;
}
