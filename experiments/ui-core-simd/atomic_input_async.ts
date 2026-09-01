import { ATOMIC_INPUT_WAKE_SEQUENCE_INDEX, type AtomicInputBuffer } from "./atomic_input.ts";

export type AtomicWaitResult = "ok" | "not-equal" | "timed-out";

type AtomicWaitAsyncResult =
  | { readonly async: false; readonly value: AtomicWaitResult }
  | { readonly async: true; readonly value: Promise<AtomicWaitResult> };

export type AtomicWaitAsync = (
  words: Int32Array,
  index: number,
  expected: number,
  timeout?: number,
) => AtomicWaitAsyncResult;

const defaultWaitAsync: AtomicWaitAsync | null = typeof Atomics.waitAsync === "function"
  ? (words, index, expected, timeout) =>
    Atomics.waitAsync(words, index, expected, timeout) as AtomicWaitAsyncResult
  : null;

/** Worker-side waiter that suspends without preventing OffscreenCanvas presentation. */
export class AtomicInputAsyncWaiter {
  readonly #wakeWord: Int32Array;
  readonly #waitAsync: AtomicWaitAsync | null;
  readonly #pollIntervalMs: number;

  private constructor(
    input: AtomicInputBuffer,
    waitAsync: AtomicWaitAsync | null,
    pollIntervalMs: number,
  ) {
    this.#wakeWord = new Int32Array(
      input.buffer,
      ATOMIC_INPUT_WAKE_SEQUENCE_INDEX * Int32Array.BYTES_PER_ELEMENT,
      1,
    );
    this.#waitAsync = waitAsync;
    this.#pollIntervalMs = pollIntervalMs;
  }

  static attach(
    input: AtomicInputBuffer,
    waitAsync: AtomicWaitAsync | null = defaultWaitAsync,
    pollIntervalMs = 8,
  ): AtomicInputAsyncWaiter {
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new RangeError("atomic input polling interval must be positive");
    }
    return new AtomicInputAsyncWaiter(input, waitAsync, pollIntervalMs);
  }

  waitForInput(sequence: number, timeout?: number): Promise<AtomicWaitResult> {
    if (this.#waitAsync !== null) {
      const waiting = this.#waitAsync(this.#wakeWord, 0, sequence | 0, timeout);
      return waiting.async ? waiting.value : Promise.resolve(waiting.value);
    }
    if (Atomics.load(this.#wakeWord, 0) !== (sequence | 0)) {
      return Promise.resolve("not-equal");
    }
    const delay = timeout === undefined
      ? this.#pollIntervalMs
      : Math.min(this.#pollIntervalMs, Math.max(0, timeout));
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(
          Atomics.load(this.#wakeWord, 0) === (sequence | 0) ? "timed-out" : "not-equal",
        );
      }, delay);
    });
  }
}
