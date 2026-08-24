import {
  RuntimeError,
  RuntimeErrorCode,
  createAbortedError,
  toRuntimeError,
} from "../errors/runtime-error.js";
import type { Clock } from "../ports/clock.js";

type AttemptTermination =
  | { readonly kind: "ABORTED"; readonly cause: unknown }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "CLOCK_ERROR"; readonly cause: unknown };

type OperationOutcome<T> =
  | { readonly kind: "VALUE"; readonly value: T }
  | { readonly kind: "ERROR"; readonly error: unknown };

const timeoutReason = (): DOMException =>
  new DOMException("The provider attempt timed out.", "TimeoutError");

const cancellationReason = (): DOMException =>
  new DOMException("The provider attempt was cancelled.", "AbortError");

const timeoutError = (): RuntimeError =>
  new RuntimeError(
    RuntimeErrorCode.PROVIDER_TIMEOUT,
    "The AI service took too long to respond.",
    { retryable: true },
  );

/**
 * Owns one provider attempt's timeout, linked external abort and cleanup.
 * The timeout race remains authoritative even when a provider ignores abort.
 */
export class ProviderAttemptScope {
  readonly signal: AbortSignal;

  private readonly attemptController = new AbortController();
  private readonly timerController = new AbortController();
  private readonly terminationPromise: Promise<AttemptTermination>;
  private readonly resolveTermination: (value: AttemptTermination) => void;
  private readonly onExternalAbort: () => void;
  private termination: AttemptTermination | undefined;
  private closed = false;

  constructor(
    clock: Clock,
    timeoutMs: number,
    private readonly externalSignal?: AbortSignal,
  ) {
    this.signal = this.attemptController.signal;

    let resolveTermination!: (value: AttemptTermination) => void;
    this.terminationPromise = new Promise((resolve) => {
      resolveTermination = resolve;
    });
    this.resolveTermination = resolveTermination;

    this.onExternalAbort = (): void => {
      this.terminate({
        kind: "ABORTED",
        cause: this.externalSignal?.reason,
      });
    };

    if (externalSignal?.aborted === true) {
      this.onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", this.onExternalAbort, {
        once: true,
      });
    }

    if (this.termination === undefined) {
      void Promise.resolve()
        .then(() => clock.sleep(timeoutMs, this.timerController.signal))
        .then(
          () => {
            this.terminate({ kind: "TIMEOUT" });
          },
          (error: unknown) => {
            if (!this.timerController.signal.aborted) {
              this.terminate({ kind: "CLOCK_ERROR", cause: error });
            }
          },
        );
    }
  }

  async race<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.throwIfTerminated();
    const operationOutcome = Promise.resolve()
      .then(() => {
        this.throwIfTerminated();
        return operation();
      })
      .then(
        (value): OperationOutcome<T> => ({ kind: "VALUE", value }),
        (error: unknown): OperationOutcome<T> => ({ kind: "ERROR", error }),
      );

    const outcome = await Promise.race([
      operationOutcome,
      this.terminationPromise,
    ]);
    if (this.termination !== undefined) {
      throw this.errorFor(this.termination);
    }
    if (outcome.kind === "VALUE") {
      return outcome.value;
    }
    if (outcome.kind === "ERROR") {
      throw outcome.error;
    }
    throw this.errorFor(outcome);
  }

  /** Stop an unfinished provider attempt before closing its iterator. */
  cancel(): void {
    if (!this.attemptController.signal.aborted) {
      this.attemptController.abort(cancellationReason());
    }
    this.close();
  }

  /** Release timer and external-signal listeners after an attempt settles. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
    if (!this.timerController.signal.aborted) {
      this.timerController.abort(cancellationReason());
    }
  }

  private terminate(termination: AttemptTermination): void {
    if (this.termination !== undefined || this.closed) {
      return;
    }
    this.termination = termination;
    if (!this.attemptController.signal.aborted) {
      this.attemptController.abort(
        termination.kind === "TIMEOUT"
          ? timeoutReason()
          : termination.kind === "ABORTED"
            ? termination.cause
            : cancellationReason(),
      );
    }
    if (!this.timerController.signal.aborted) {
      this.timerController.abort(cancellationReason());
    }
    this.resolveTermination(termination);
  }

  private throwIfTerminated(): void {
    if (this.termination !== undefined) {
      throw this.errorFor(this.termination);
    }
  }

  private errorFor(termination: AttemptTermination): RuntimeError {
    switch (termination.kind) {
      case "ABORTED":
        return createAbortedError(termination.cause);
      case "TIMEOUT":
        return timeoutError();
      case "CLOCK_ERROR":
        return toRuntimeError(termination.cause);
    }
  }
}
