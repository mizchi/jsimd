import { ShardedBitmap, SharedBarrier, SharedBuffer } from "./mod.ts";

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

Deno.test("ShardedBitmap defines attachable cache-line-isolated writer shards", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const bitmap = ShardedBitmap.initialize(owner, 0, { capacity: 131, shardCount: 3 });
  const peer = ShardedBitmap.attach(attached, 0);
  assert(bitmap.capacity === 131 && bitmap.shardCount === 3, "shape");
  assert(bitmap.wordCount === 5, "word count");
  assert(bitmap.shardStride % 64 === 0, "shard isolation");
  assert(bitmap.dataByteOffset % 64 === 0 && bitmap.byteLength % 64 === 0, "alignment");

  const shard = bitmap.claimShard(1);
  assertThrows(() => peer.claimShard(1), RangeError, "writer must be exclusive");
  shard.set(0);
  shard.set(130);
  assert(shard.has(0) && shard.has(130), "shard values");
  shard[Symbol.dispose]();
  using reused = peer.claimShard(1);
  assert(reused.has(0) && reused.has(130), "released shard data persists");
});

Deno.test("ShardedBitmap rounds every shard stride up to a cache line", async () => {
  using shared = await SharedBuffer.create();
  const bitmap = ShardedBitmap.initialize(shared, 0, { capacity: 513, shardCount: 2 });
  assert(bitmap.wordCount === 17, "word count");
  assert(bitmap.shardStride === 128, "80-byte payload must occupy two cache lines");
  assert(bitmap.shardStride % 64 === 0, "every shard starts on a cache-line boundary");
});

Deno.test("ShardedBitmap reduces OR and AND through generation-checked result views", async () => {
  using shared = await SharedBuffer.create();
  const bitmap = ShardedBitmap.initialize(shared, 0, { capacity: 131, shardCount: 3 });
  {
    using first = bitmap.claimShard(0);
    first.set(1);
    first.set(31);
    first.set(130);
  }
  {
    using second = bitmap.claimShard(1);
    second.set(1);
    second.set(32);
    second.set(130);
  }
  {
    using third = bitmap.claimShard(2);
    third.set(1);
    third.set(64);
  }

  const union = bitmap.reduceOr();
  assert(union.has(1) && union.has(31) && union.has(32), "OR low bits");
  assert(union.has(64) && union.has(130), "OR high bits");
  assert(union.countOnes() === 5, "OR count");
  const words = new Uint32Array(bitmap.wordCount);
  assert(union.wordsInto(words) === bitmap.wordCount, "words written");
  assertEquals(words, [0x8000_0002, 1, 1, 0, 4], "OR words");

  const intersection = bitmap.reduceAnd();
  assertThrows(() => union.has(1), Error, "old result view must be stale");
  assert(intersection.has(1), "AND shared bit");
  assert(intersection.countOnes() === 1, "AND count");
});

Deno.test("ShardedBitmap performs barrier-delimited reduction across Web Workers", async () => {
  const workerCount = 4;
  using shared = await SharedBuffer.create({ maxWorkers: workerCount + 1 });
  const bitmap = ShardedBitmap.initialize(shared, 0, { capacity: 256, shardCount: workerCount });
  const barrierOffset = bitmap.byteLength;
  const barrier = SharedBarrier.initialize(shared, barrierOffset, workerCount + 1);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBarrier, SharedBuffer, ShardedBitmap } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const bitmap = ShardedBitmap.attach(shared, 0);
    const barrier = SharedBarrier.attach(shared, event.data.barrierOffset);
    {
      using shard = bitmap.claimShard(event.data.shard);
      shard.set(event.data.shard);
      shard.set(100);
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
    workers.forEach((worker, shard) =>
      worker.postMessage({ memory: shared.memory, barrierOffset, shard })
    );
    await barrier.arriveAndWaitAsync();
    const union = bitmap.reduceOr();
    for (let bit = 0; bit < workerCount; bit++) assert(union.has(bit), `worker bit ${bit}`);
    assert(union.has(100) && union.countOnes() === workerCount + 1, "union result");
    const intersection = bitmap.reduceAnd();
    assert(intersection.has(100) && intersection.countOnes() === 1, "intersection result");
    await Promise.all(completions);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases returned");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("ShardedBitmap validates options, indices, result outputs, and lifetimes", async () => {
  const shared = await SharedBuffer.create();
  assertThrows(
    () => ShardedBitmap.initialize(shared, 0, { capacity: 64, shardCount: 0 }),
    RangeError,
    "positive shard count",
  );
  assertThrows(
    () => ShardedBitmap.initialize(shared, 4, { capacity: 64, shardCount: 1 }),
    RangeError,
    "alignment",
  );
  const bitmap = ShardedBitmap.initialize(shared, 0, { capacity: 65, shardCount: 2 });
  assertThrows(() => bitmap.claimShard(2), RangeError, "shard bounds");
  const shard = bitmap.claimShard(0);
  assertThrows(() => shard.set(65), RangeError, "bit bounds");
  shard[Symbol.dispose]();
  assertThrows(() => shard.has(0), Error, "disposed shard");
  const result = bitmap.reduceOr();
  assertThrows(() => result.wordsInto(new Uint32Array(2)), RangeError, "small output");
  shared[Symbol.dispose]();
  assertThrows(() => result.has(0), Error, "disposed backing lease");
});

interface WorkerResult {
  readonly phase: string;
  readonly message?: string;
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.phase === "done") resolve(event.data);
      else reject(new Error(event.data.message ?? "ShardedBitmap worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
