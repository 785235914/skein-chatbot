import { createAbortedError, throwIfAborted } from "../errors/runtime-error.js";
import type { Clock } from "../ports/clock.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return Promise.reject(new RangeError("milliseconds must be non-negative"));
    }
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        operation();
      };
      const onAbort = (): void => {
        clearTimeout(timer);
        finish(() => {
          reject(createAbortedError(signal?.reason));
        });
      };
      const timer = setTimeout(() => {
        finish(resolve);
      }, milliseconds);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }
}
