import { SharedBarrier, SharedBuffer, StripedCounter, StripedHistogram } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: ArrayLike<number>,
  expected: readonly number[],
  message: string,
): void {
  assert(actual.length === expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index++) {
    assert(actual[index] === expected[index], `${message}: index ${index}`);
  }
}

function assertThrows(operation: () => unknown, constructor: typeof Error, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}

Deno.test("StripedCounter isolates disposable writer stripes and sums after a barrier", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const counter = StripedCounter.initialize(owner, 0, 3);
  const peer = StripedCounter.attach(attached, 0);
  assert(counter.stripeStride === 64, "counter stripes use separate cache lines");
  {
    using stripe = counter.claimStripe(0);
    stripe.add(4);
    stripe.increment();
    assert(stripe.value === 5, "local value");
    assertThrows(() => peer.claimStripe(0), RangeError, "exclusive stripe");
  }
  {
    using stripe = peer.claimStripe(1);
    stripe.add(7);
  }
  assert(counter.sum() === 12, "exact sum");
});

Deno.test("StripedHistogram performs a bulk SIMD sum into caller storage", async () => {
  using shared = await SharedBuffer.create();
  const histogram = StripedHistogram.initialize(shared, 0, { bucketCount: 5, stripeCount: 3 });
  for (let stripeIndex = 0; stripeIndex < histogram.stripeCount; stripeIndex++) {
    using stripe = histogram.claimStripe(stripeIndex);
    stripe.add(0, stripeIndex + 1);
    stripe.increment(stripeIndex + 1);
  }
  const output = new Uint32Array(5);
  assert(histogram.reduceInto(output) === 5, "written bucket count");
  assertEquals(output, [6, 1, 1, 1, 0], "reduced buckets");
  using stripe = histogram.claimStripe(2);
  stripe.clearAll();
  histogram.reduceInto(output);
  assertEquals(output, [3, 1, 1, 0, 0], "cleared stripe");
});

Deno.test("StripedHistogram observes Worker writes after an external barrier", async () => {
  const workerCount = 4;
  using shared = await SharedBuffer.create({ maxWorkers: workerCount + 1 });
  const histogram = StripedHistogram.initialize(shared, 0, {
    bucketCount: 8,
    stripeCount: workerCount,
  });
  const barrierOffset = histogram.byteLength;
  const barrier = SharedBarrier.initialize(shared, barrierOffset, workerCount + 1);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBarrier, SharedBuffer, StripedHistogram } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const histogram = StripedHistogram.attach(shared, 0);
    const barrier = SharedBarrier.attach(shared, event.data.barrierOffset);
    {
      using stripe = histogram.claimStripe(event.data.stripe);
      stripe.add(0, 10);
      stripe.increment(event.data.stripe + 1);
      barrier.arriveAndWait();
    }
    self.postMessage({ phase: "done" });
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const workers = Array.from({ length: workerCount }, () =>
    new Worker(workerUrl, {
      type: "module",
    }));
  try {
    const completions = workers.map(waitForWorker);
    workers.forEach((worker, stripe) =>
      worker.postMessage({ memory: shared.memory, barrierOffset, stripe })
    );
    await barrier.arriveAndWaitAsync();
    const output = new Uint32Array(histogram.bucketCount);
    histogram.reduceInto(output);
    assertEquals(output, [40, 1, 1, 1, 1, 0, 0, 0], "worker reduction");
    await Promise.all(completions);
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("Striped accumulators validate layouts, bounds, and lifetimes", async () => {
  const shared = await SharedBuffer.create();
  assertThrows(
    () => StripedHistogram.initialize(shared, 0, { bucketCount: 4, stripeCount: 0 }),
    RangeError,
    "positive stripe count",
  );
  assertThrows(() => StripedCounter.initialize(shared, 4, 2), RangeError, "alignment");
  const histogram = StripedHistogram.initialize(shared, 0, {
    bucketCount: 17,
    stripeCount: 2,
  });
  assert(histogram.stripeStride === 128, "wide stripe cache-line rounding");
  assertThrows(() => histogram.claimStripe(2), RangeError, "stripe bounds");
  const stripe = histogram.claimStripe(0);
  assertThrows(() => stripe.increment(17), RangeError, "bucket bounds");
  stripe[Symbol.dispose]();
  assertThrows(() => stripe.increment(0), Error, "disposed stripe");
  assertThrows(() => histogram.reduceInto(new Uint32Array(16)), RangeError, "small output");
  shared[Symbol.dispose]();
  assertThrows(() => histogram.reduceInto(new Uint32Array(17)), Error, "disposed backing lease");
});

interface WorkerResult {
  readonly phase: string;
  readonly message?: string;
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.phase === "done") resolve(event.data);
      else reject(new Error(event.data.message ?? "striped accumulator worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
