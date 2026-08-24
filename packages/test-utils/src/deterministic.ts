import {
  throwIfAborted,
  type Clock,
  type IdGenerator,
} from "@skein-chatbot/core";

export class ManualClock implements Clock {
  private currentMilliseconds: number;

  constructor(initial: string | Date = "2026-01-01T00:00:00.000Z") {
    this.currentMilliseconds = new Date(initial).getTime();
    if (!Number.isFinite(this.currentMilliseconds)) {
      throw new RangeError("initial must be a valid date");
    }
  }

  now(): Date {
    return new Date(this.currentMilliseconds);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("milliseconds must be non-negative");
    }
    this.currentMilliseconds += milliseconds;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.advance(milliseconds);
    return Promise.resolve();
  }
}

export class SequenceIdGenerator implements IdGenerator {
  private index = 0;

  constructor(
    private readonly values: readonly string[] = [],
    private readonly prefix = "id",
  ) {}

  generate(): string {
    const value = this.values[this.index];
    this.index += 1;
    return value ?? `${this.prefix}-${this.index}`;
  }
}
