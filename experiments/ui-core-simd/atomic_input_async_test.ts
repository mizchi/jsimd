import { AtomicInputBuffer } from "./atomic_input.ts";
import { AtomicInputAsyncWaiter } from "./atomic_input_async.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("AtomicInputAsyncWaiter yields until a producer wakes it", async () => {
  const input = AtomicInputBuffer.create(8);
  const waiter = AtomicInputAsyncWaiter.attach(input);
  const sequence = input.wakeSequence;
  let producerRan = false;
  // Native Atomics.waitAsync does not itself keep Deno's event loop alive.
  setTimeout(() => {
    producerRan = true;
    input.wake();
  }, 0);

  const keepAlive = setInterval(() => {}, 10);
  try {
    assertEquals(await waiter.waitForInput(sequence, 100), "ok");
    assertEquals(producerRan, true);
  } finally {
    clearInterval(keepAlive);
  }
});

Deno.test("AtomicInputAsyncWaiter polling fallback observes changes without blocking", async () => {
  const input = AtomicInputBuffer.create(8);
  const waiter = AtomicInputAsyncWaiter.attach(input, null, 1);
  const sequence = input.wakeSequence;
  setTimeout(() => input.wake(), 0);

  assertEquals(await waiter.waitForInput(sequence), "not-equal");
});

Deno.test("AtomicInputAsyncWaiter polling fallback reports a bounded timeout", async () => {
  const input = AtomicInputBuffer.create(8);
  const waiter = AtomicInputAsyncWaiter.attach(input, null, 1);

  assertEquals(await waiter.waitForInput(input.wakeSequence, 0), "timed-out");
});
