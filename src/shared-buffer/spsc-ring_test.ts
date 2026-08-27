import { SharedBuffer, SpscRingBufferU32 } from "./mod.ts";

function assert(condition: boolean, message: string): void {
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

Deno.test("SpscRingBufferU32 defines cache-line-separated exclusive roles", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 3 });
  using attached = await SharedBuffer.attach(owner.memory);
  const ring = SpscRingBufferU32.initialize(owner, 0, 8);
  const peer = SpscRingBufferU32.attach(attached, 0);
  assert(ring.capacity === 8, "capacity");
  assert(ring.dataByteOffset % 64 === 0, "data alignment");
  assert(ring.byteLength % 64 === 0, "layout alignment");

  const producer = ring.producer();
  const consumer = peer.consumer();
  assertThrows(() => peer.producer(), RangeError, "producer role must be exclusive");
  assert(producer.tryPush(0xffff_ffff), "push u32");
  assert(consumer.tryPop() === 0xffff_ffff, "pop u32");
  producer[Symbol.dispose]();
  consumer[Symbol.dispose]();
  using reusedProducer = peer.producer();
  using reusedConsumer = ring.consumer();
  assert(!reusedProducer.disposed && !reusedConsumer.disposed, "released roles must be reusable");
});

Deno.test("SpscRingBufferU32 bulk operations preserve wraparound order", async () => {
  using owner = await SharedBuffer.create();
  const ring = SpscRingBufferU32.initialize(owner, 0, 8);
  using producer = ring.producer();
  using consumer = ring.consumer();
  assert(producer.pushMany(Uint32Array.from([0, 1, 2, 3, 4, 5, 6])) === 7, "first batch");
  const first = new Uint32Array(5);
  assert(consumer.popMany(first) === 5, "first pop");
  assertEquals(first, [0, 1, 2, 3, 4], "first values");
  assert(producer.pushMany(Uint32Array.from([7, 8, 9, 10, 11, 12])) === 6, "wrapped batch");
  assert(!producer.tryPush(13), "full ring");
  const second = new Uint32Array(8);
  assert(consumer.popMany(second) === 8, "wrapped pop");
  assertEquals(second, [5, 6, 7, 8, 9, 10, 11, 12], "wrapped values");
  assert(consumer.tryPop() === undefined, "empty ring");
});

Deno.test("SpscRingBufferU32 counters roll over without changing FIFO order", async () => {
  using owner = await SharedBuffer.create();
  const ringOffset = 0;
  const ring = SpscRingBufferU32.initialize(owner, ringOffset, 8);
  Atomics.store(owner.int32Array(ringOffset + 64, 1), 0, -3);
  Atomics.store(owner.int32Array(ringOffset + 128, 1), 0, -3);
  using producer = ring.producer();
  using consumer = ring.consumer();
  const values = Uint32Array.from([10, 11, 12, 13, 14]);
  assert(producer.pushMany(values) === values.length, "rollover push");
  const output = new Uint32Array(values.length);
  assert(consumer.popMany(output) === output.length, "rollover pop");
  assertEquals(output, [...values], "rollover values");
});

Deno.test("SpscRingBufferU32 uses SIMD for shared-to-shared bulk transfer", async () => {
  using owner = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const ring = SpscRingBufferU32.initialize(owner, 0, 16);
  using producer = ring.producer();
  using consumer = ring.consumer();
  const sourceOffset = 1_024;
  const destinationOffset = 2_048;
  const values = Uint32Array.from({ length: 12 }, (_, index) => index * 17 + 3);
  owner.uint32Array(sourceOffset, values.length).set(values);
  assert(producer.pushManyFromShared(sourceOffset, values.length) === values.length, "shared push");
  assert(
    consumer.popManyToShared(destinationOffset, values.length) === values.length,
    "shared pop",
  );
  assertEquals(
    owner.uint32Array(destinationOffset, values.length),
    [...values],
    "SIMD copy values",
  );
});

Deno.test("SpscRingBufferU32 applies blocking backpressure across Web Workers", async () => {
  const itemCount = 4_096;
  using shared = await SharedBuffer.create({ maxWorkers: 2 });
  const ringOffset = 0;
  const ring = SpscRingBufferU32.initialize(shared, ringOffset, 64);
  using consumer = ring.consumer();
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBuffer, SpscRingBufferU32 } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const ring = SpscRingBufferU32.attach(shared, event.data.ringOffset);
    using producer = ring.producer();
    for (let value = 0; value < event.data.itemCount; value++) producer.push(value);
    self.postMessage({ phase: "done" });
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl, { type: "module" });
  try {
    const completion = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ phase: string; message?: string }>) => {
        if (event.data.phase === "done") resolve();
        else reject(new Error(event.data.message ?? "SPSC worker failed"));
      };
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    });
    worker.postMessage({ memory: shared.memory, ringOffset, itemCount });
    for (let expected = 0; expected < itemCount; expected++) {
      assert(await consumer.popAsync() === expected, `backpressure value ${expected}`);
    }
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker lease returned");
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("SpscRingBufferU32 validates capacity and endpoint disposal", async () => {
  using shared = await SharedBuffer.create();
  assertThrows(() => SpscRingBufferU32.initialize(shared, 0, 7), RangeError, "power of two");
  const ring = SpscRingBufferU32.initialize(shared, 0, 8);
  const producer = ring.producer();
  producer[Symbol.dispose]();
  assertThrows(() => producer.tryPush(1), Error, "disposed producer");
  using nextProducer = ring.producer();
  assertThrows(() => nextProducer.tryPush(0x1_0000_0000), RangeError, "u32 value");
});
