import { MpmcRingBufferU64, SharedBuffer, SharedSlotMap, SpscRingBufferU64 } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: BigUint64Array, expected: readonly bigint[], message: string): void {
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

Deno.test("SpscRingBufferU64 transports complete generation-tagged handles", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const ring = SpscRingBufferU64.initialize(owner, 0, 8);
  const peer = SpscRingBufferU64.attach(attached, 0);
  using producer = ring.producer();
  using consumer = peer.consumer();
  const handles = BigUint64Array.from([
    0n,
    0x0000_0001_ffff_ffffn,
    0x7fff_ffff_ffff_ffffn,
    0xffff_ffff_ffff_ffffn,
  ]);
  assert(producer.pushMany(handles) === handles.length, "bulk push");
  const output = new BigUint64Array(handles.length);
  assert(consumer.popMany(output) === output.length, "bulk pop");
  assertEquals(output, [...handles], "complete u64 values");
  assert(ring.dataByteOffset % 64 === 0 && ring.byteLength % 64 === 0, "aligned layout");
});

Deno.test("SpscRingBufferU64 preserves FIFO across counter and data wraparound", async () => {
  using shared = await SharedBuffer.create();
  const ring = SpscRingBufferU64.initialize(shared, 0, 8);
  Atomics.store(shared.int32Array(64, 1), 0, -3);
  Atomics.store(shared.int32Array(128, 1), 0, -3);
  using producer = ring.producer();
  using consumer = ring.consumer();
  const values = BigUint64Array.from([10n, 11n, 12n, 13n, 14n]);
  assert(producer.pushMany(values) === values.length, "rollover push");
  const output = new BigUint64Array(values.length);
  assert(consumer.popMany(output) === output.length, "rollover pop");
  assertEquals(output, [...values], "rollover values");
});

Deno.test("MpmcRingBufferU64 preserves bounded FIFO and complete u64 values", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const ring = MpmcRingBufferU64.initialize(owner, 0, 8);
  const peer = MpmcRingBufferU64.attach(attached, 0);
  const values = BigUint64Array.from([
    0n,
    1n,
    0x0000_0001_ffff_ffffn,
    0x7fff_ffff_ffff_ffffn,
    0xffff_ffff_ffff_ffffn,
  ]);
  assert(ring.pushMany(values) === values.length, "bulk push");
  const output = new BigUint64Array(values.length);
  assert(peer.popMany(output) === output.length, "bulk pop");
  assertEquals(output, [...values], "complete u64 values");
  assert(ring.dataByteOffset % 64 === 0 && ring.byteLength % 64 === 0, "aligned layout");
});

Deno.test("MpmcRingBufferU64 transports SharedSlotMap handles across a Worker", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 2 });
  const queueOffset = 0;
  const queue = MpmcRingBufferU64.initialize(shared, queueOffset, 8);
  const slotsOffset = queue.byteLength;
  const slots = SharedSlotMap.initialize(shared, slotsOffset, {
    capacity: 4,
    payloadByteLength: 8,
  });
  using slot = slots.allocate();
  slot.uint32Array(0, 2).set([0x1234_5678, 0x9abc_def0]);

  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { MpmcRingBufferU64, SharedBuffer, SharedSlotMap } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const queue = MpmcRingBufferU64.attach(shared, event.data.queueOffset);
    const slots = SharedSlotMap.attach(shared, event.data.slotsOffset);
    const handle = queue.pop();
    const view = slots.get(handle);
    if (view === undefined) throw new Error("missing slot");
    view.uint32Array(0, 2).set([0xfeed_beef, 0xcafe_babe]);
    queue.push(handle);
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
        else reject(new Error(event.data.message ?? "u64 queue worker failed"));
      };
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    });
    worker.postMessage({ memory: shared.memory, queueOffset, slotsOffset });
    queue.push(slot.handle);
    await completion;
    assert(await queue.popAsync() === slot.handle, "same handle returned atomically");
    assertEquals(
      new BigUint64Array(slot.uint32Array(0, 2).buffer, slot.uint32Array(0, 2).byteOffset, 1),
      [0xcafe_babe_feed_beefn],
      "worker updated slot",
    );
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("MpmcRingBufferU64 coordinates contended producers and consumers", async () => {
  const producerCount = 2;
  const consumerCount = 2;
  const valuesPerProducer = 1_024;
  const sentinel = 0xffff_ffff_ffff_ffffn;
  using shared = await SharedBuffer.create({ maxWorkers: producerCount + consumerCount + 1 });
  const ring = MpmcRingBufferU64.initialize(shared, 0, 128);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { MpmcRingBufferU64, SharedBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const ring = MpmcRingBufferU64.attach(shared, 0);
    if (event.data.role === "producer") {
      const generation = BigInt(event.data.id + 1) << 32n;
      for (let index = 0; index < event.data.count; index++) ring.push(generation | BigInt(index));
      self.postMessage({ phase: "done", values: [] });
    } else {
      const values = [];
      while (true) {
        const value = ring.pop();
        if (value === event.data.sentinel) break;
        values.push(value);
      }
      self.postMessage({ phase: "done", values });
    }
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const consumers = Array.from({ length: consumerCount }, () =>
    new Worker(workerUrl, {
      type: "module",
    }));
  const producers = Array.from({ length: producerCount }, () =>
    new Worker(workerUrl, {
      type: "module",
    }));
  const workers = [...consumers, ...producers];
  try {
    const consumerResults = consumers.map(waitForWorker);
    const producerResults = producers.map(waitForWorker);
    consumers.forEach((worker) =>
      worker.postMessage({ memory: shared.memory, role: "consumer", sentinel })
    );
    producers.forEach((worker, id) =>
      worker.postMessage({ memory: shared.memory, role: "producer", id, count: valuesPerProducer })
    );
    await Promise.all(producerResults);
    for (let index = 0; index < consumerCount; index++) await ring.pushAsync(sentinel);
    const results = await Promise.all(consumerResults);
    const values = results.flatMap((result) => result.values).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    const expected = Array.from({ length: producerCount }, (_, producer) =>
      Array.from(
        { length: valuesPerProducer },
        (_, index) => BigInt(producer + 1) << 32n | BigInt(index),
      )).flat();
    assert(values.length === expected.length, "all values consumed");
    for (let index = 0; index < expected.length; index++) {
      assert(values[index] === expected[index], `unique value ${index}`);
    }
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("u64 rings validate values, capacity, roles, and disposal", async () => {
  using shared = await SharedBuffer.create();
  assertThrows(() => SpscRingBufferU64.initialize(shared, 0, 7), RangeError, "SPSC capacity");
  assertThrows(() => MpmcRingBufferU64.initialize(shared, 0, 7), RangeError, "MPMC capacity");
  const spsc = SpscRingBufferU64.initialize(shared, 0, 8);
  using producer = spsc.producer();
  assertThrows(() => producer.tryPush(-1n), RangeError, "negative u64");
  assertThrows(() => producer.tryPush(0x1_0000_0000_0000_0000n), RangeError, "overflow u64");
  const mpmc = MpmcRingBufferU64.initialize(shared, spsc.byteLength, 8);
  assertThrows(
    () => mpmc.tryPush(1 as unknown as bigint),
    TypeError,
    "number is not bigint",
  );
});

interface WorkerResult {
  readonly phase: string;
  readonly values: bigint[];
  readonly message?: string;
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.phase === "done") resolve(event.data);
      else reject(new Error(event.data.message ?? "u64 MPMC worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
