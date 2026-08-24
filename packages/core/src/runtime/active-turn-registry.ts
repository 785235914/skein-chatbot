export interface ActiveTurnScope {
  readonly signal: AbortSignal;
  close(): void;
}

/** Tracks all in-flight turns for a session without exposing controllers. */
export class ActiveTurnRegistry {
  private readonly controllers = new Map<string, Set<AbortController>>();

  register(sessionId: string, parentSignal?: AbortSignal): ActiveTurnScope {
    const controller = new AbortController();
    let closed = false;
    const onParentAbort = (): void => {
      controller.abort(parentSignal?.reason);
    };

    if (parentSignal?.aborted === true) {
      onParentAbort();
    } else {
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    }

    const active = this.controllers.get(sessionId) ?? new Set<AbortController>();
    active.add(controller);
    this.controllers.set(sessionId, active);

    return {
      signal: controller.signal,
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        parentSignal?.removeEventListener("abort", onParentAbort);
        const current = this.controllers.get(sessionId);
        current?.delete(controller);
        if (current?.size === 0) {
          this.controllers.delete(sessionId);
        }
      },
    };
  }

  abort(sessionId: string): boolean {
    const active = this.controllers.get(sessionId);
    if (active === undefined || active.size === 0) {
      return false;
    }
    for (const controller of active) {
      controller.abort("session abort requested");
    }
    return true;
  }
}
