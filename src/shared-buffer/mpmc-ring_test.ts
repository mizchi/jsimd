import { MpmcRingBufferU32, SharedBuffer } from "./mod.ts";

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

Deno.test("MpmcRingBufferU32 defines an attachable cache-line-separated layout", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const ring = MpmcRingBufferU32.initialize(owner, 0, 8);
  const peer = MpmcRingBufferU32.attach(attached, 0);
  assert(ring.capacity === 8 && peer.capacity === 8, "capacity");
  assert(ring.dataByteOffset % 64 === 0, "slot alignment");
  assert(ring.byteLength % 64 === 0, "layout alignment");
  assert(ring.tryPush(0xffff_ffff), "push complete u32 range");
  assert(peer.tryPop() === 0xffff_ffff, "attached pop");
});

Deno.test("MpmcRingBufferU32 preserves bounded FIFO and bulk behavior", async () => {
  using shared = await SharedBuffer.create();
  const ring = MpmcRingBufferU32.initialize(shared, 0, 8);
  assert(ring.pushMany(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8])) === 8, "fill");
  assert(!ring.tryPush(9), "full queue");
  const first = new Uint32Array(5);
  assert(ring.popMany(first) === first.length, "first batch");
  assertEquals(first, [0, 1, 2, 3, 4], "first values");
  assert(ring.pushMany(Uint32Array.from([8, 9, 10, 11, 12])) === 5, "wrapped push");
  const second = new Uint32Array(8);
  assert(ring.popMany(second) === second.length, "wrapped pop");
  assertEquals(second, [5, 6, 7, 8, 9, 10, 11, 12], "wrapped values");
  assert(ring.tryPop() === undefined, "empty queue");
});

Deno.test("MpmcRingBufferU32 sequence numbers survive u32 rollover", async () => {
  using shared = await SharedBuffer.create();
  const capacity = 8;
  const ring = MpmcRingBufferU32.initialize(shared, 0, capacity);
  const base = 0xffff_fffc;
  Atomics.store(shared.int32Array(64, 1), 0, base);
  Atomics.store(shared.int32Array(128, 1), 0, base);
  for (let distance = 0; distance < capacity; distance++) {
    const position = (base + distance) >>> 0;
    const slot = position & (capacity - 1);
    Atomics.store(shared.int32Array(192 + slot * 8, 1), 0, position);
  }
  const values = Uint32Array.from([10, 11, 12, 13, 14]);
  assert(ring.pushMany(values) === values.length, "rollover push");
  const output = new Uint32Array(values.length);
  assert(ring.popMany(output) === output.length, "rollover pop");
  assertEquals(output, [...values], "rollover values");
});

Deno.test("MpmcRingBufferU32 coordinates multiple producers and consumers", async () => {
  const producerCount = 2;
  const consumerCount = 2;
  const valuesPerProducer = 2_048;
  const sentinel = 0xffff_ffff;
  using shared = await SharedBuffer.create({ maxWorkers: producerCount + consumerCount + 1 });
  const ringOffset = 0;
  const ring = MpmcRingBufferU32.initialize(shared, ringOffset, 128);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { MpmcRingBufferU32, SharedBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const ring = MpmcRingBufferU32.attach(shared, event.data.ringOffset);
    if (event.data.role === "producer") {
      const base = event.data.id * event.data.count;
      for (let index = 0; index < event.data.count; index++) ring.push(base + index);
      self.postMessage({ phase: "done", role: "producer" });
    } else {
      const values = [];
      while (true) {
        const value = ring.pop();
        if (value === event.data.sentinel) break;
        values.push(value);
      }
      self.postMessage({ phase: "done", role: "consumer", values });
    }
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const consumers = Array.from(
    { length: consumerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  const producers = Array.from(
    { length: producerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  const workers = [...consumers, ...producers];
  try {
    const consumerResults = consumers.map(waitForWorker);
    const producerResults = producers.map(waitForWorker);
    consumers.forEach((worker) =>
      worker.postMessage({
        memory: shared.memory,
        ringOffset,
        role: "consumer",
        sentinel,
      })
    );
    producers.forEach((worker, id) =>
      worker.postMessage({
        memory: shared.memory,
        ringOffset,
        role: "producer",
        id,
        count: valuesPerProducer,
      })
    );
    await Promise.all(producerResults);
    for (let index = 0; index < consumerCount; index++) await ring.pushAsync(sentinel);
    const results = await Promise.all(consumerResults);
    const values = results.flatMap((result) => result.values ?? []).sort((left, right) =>
      left - right
    );
    assert(values.length === producerCount * valuesPerProducer, "all values consumed");
    assertEquals(
      values,
      Array.from({ length: values.length }, (_, index) => index),
      "unique producer values",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases returned");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("MpmcRingBufferU32 validates capacity, values, and disposal", async () => {
  using shared = await SharedBuffer.create();
  assertThrows(() => MpmcRingBufferU32.initialize(shared, 0, 7), RangeError, "power of two");
  const ring = MpmcRingBufferU32.initialize(shared, 0, 8);
  assertThrows(() => ring.tryPush(0x1_0000_0000), RangeError, "u32 value");
  shared[Symbol.dispose]();
  assertThrows(() => ring.tryPop(), Error, "disposed buffer");
});

interface WorkerResult {
  readonly phase: string;
  readonly message?: string;
  readonly values?: number[];
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.phase === "done") resolve(event.data);
      else reject(new Error(event.data.message ?? "MPMC worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
