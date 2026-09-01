import {
  estimateAtomicBridgeBytes,
  summarizeInteractionSamples,
  validateProfileBindingCount,
} from "./runtime_profile.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

Deno.test("interaction profile separates input, main-thread, worker, commit, and total latency", () => {
  const summary = summarizeInteractionSamples([
    {
      inputDelayMs: 1,
      eventLoopDelayMs: 2,
      mainThreadMs: 2,
      workerMs: 3,
      commitMs: 4,
      eventToDomMs: 10,
    },
    {
      inputDelayMs: 2,
      eventLoopDelayMs: 4,
      mainThreadMs: 4,
      workerMs: 6,
      commitMs: 8,
      eventToDomMs: 20,
    },
    {
      inputDelayMs: 3,
      eventLoopDelayMs: 6,
      mainThreadMs: 6,
      workerMs: 9,
      commitMs: 12,
      eventToDomMs: 30,
    },
  ]);
  assertEquals(summary.inputDelay.median, 2, "input median");
  assertEquals(summary.eventLoopDelay.median, 4, "event-loop median");
  assertEquals(summary.mainThread.median, 4, "main-thread median");
  assertEquals(summary.worker.median, 6, "worker median");
  assertEquals(summary.commit.median, 8, "commit median");
  assertEquals(summary.eventToDom.p95, 30, "event-to-DOM p95");
});

Deno.test("atomic bridge estimate includes values and padded dirty bitmap", () => {
  const estimate = estimateAtomicBridgeBytes(4_096);
  assertEquals(estimate.valueBytes, 16_384, "shared values");
  assertEquals(estimate.dirtyBytes, 576, "dirty bitmap with header");
  assertEquals(estimate.totalBytes, 16_960, "total shared backing");
});

Deno.test("runtime profile accepts supported large binding counts", () => {
  assertEquals(validateProfileBindingCount(4_096), 4_096, "valid count");
  assertThrows(() => validateProfileBindingCount(0), RangeError);
  assertThrows(() => validateProfileBindingCount(65), RangeError);
});

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
