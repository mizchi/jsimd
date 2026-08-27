import {
  SHARED_BLOCK_SIZES,
  SHARED_SYNC_BYTE_LENGTH,
  SharedBarrier,
  SharedBlockPool,
  SharedBuffer,
  SharedWaitGroup,
} from "./mod.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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

Deno.test("SharedBlockPool defines attachable aligned size classes", async () => {
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 2 });
  const pool = SharedBlockPool.initialize(shared, 0);
  const attached = SharedBlockPool.attach(shared, 0);
  assert(pool.metadataByteLength === SharedBlockPool.metadataByteLength(2), "metadata size");
  assert(pool.arenaStart % 4_096 === 0, "arena alignment");
  assert(attached.arenaStart === pool.arenaStart, "attached arena");

  for (const size of SHARED_BLOCK_SIZES) {
    using block = pool.allocate(size);
    assert(block.byteOffset % size === 0, `${size}-byte block alignment`);
    assert(block.byteLength === size, "block byte length");
    block.uint8Array().fill(size & 0xff);
    assert(block.uint8Array()[0] === (size & 0xff), "shared block view");
    assertThrows(() => block.uint32Array(size, 1), RangeError, "block-local bounds");
  }
  assert(pool.outstandingBlocks === 0, "using must return blocks");
  const released = pool.allocate(256);
  const releasedPointer = released.byteOffset;
  released[Symbol.dispose]();
  assert(released.disposed, "released block state");
  assertThrows(() => released.uint8Array(), Error, "released block use");
  released[Symbol.dispose]();
  using reused = pool.allocate(256);
  assert(reused.byteOffset === releasedPointer, "local cache must reuse the newest block");
});

Deno.test("SharedBlockPool reuses released blocks without growing the arena", async () => {
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 1 });
  const pool = SharedBlockPool.initialize(shared, 0);
  let plateau = 0;
  for (let round = 0; round < 20; round++) {
    const blocks = Array.from({ length: 64 }, () => pool.allocate(256));
    const pointers = new Set(blocks.map((block) => block.byteOffset));
    assert(pointers.size === blocks.length, "live blocks must not alias");
    for (const block of blocks) block[Symbol.dispose]();
    assert(pool.outstandingBlocks === 0, "all blocks returned");
    if (round === 0) plateau = pool.reservedBytes;
    else assert(pool.reservedBytes === plateau, "reused blocks must not advance bump pointer");
  }
});

Deno.test("SharedBlockPool recovers a terminated worker cache and keeps allocation flat", async () => {
  using coordinator = await SharedBuffer.create({
    initialPages: 2,
    maximumPages: 2,
    maxWorkers: 2,
  });
  const pool = SharedBlockPool.initialize(coordinator, 0);
  const terminated = await SharedBuffer.attach(coordinator.memory);
  const terminatedPool = SharedBlockPool.attach(terminated, 0);
  const blocks = Array.from({ length: 9 }, () => terminatedPool.allocate(256));
  for (const block of blocks) block[Symbol.dispose]();
  const plateau = pool.reservedBytes;
  const staleLease = terminated.workerLease;

  assert(coordinator.reclaimTerminatedWorker(staleLease), "worker lease reclaimed");
  assert(pool.reclaimTerminatedWorker(staleLease) > 0, "cached free blocks recovered");
  using replacement = await SharedBuffer.attach(coordinator.memory);
  const replacementPool = SharedBlockPool.attach(replacement, 0);
  const reused = Array.from({ length: 9 }, () => replacementPool.allocate(256));
  assert(pool.reservedBytes === plateau, "recovery must not advance the bump pointer");
  for (const block of reused) block[Symbol.dispose]();
});

Deno.test("SharedBlockPool recovers after forced Web Worker termination", async () => {
  using coordinator = await SharedBuffer.create({
    initialPages: 2,
    maximumPages: 2,
    maxWorkers: 2,
  });
  const pool = SharedBlockPool.initialize(coordinator, 0);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBlockPool, SharedBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  const shared = await SharedBuffer.attach(event.data.memory);
  const pool = SharedBlockPool.attach(shared, 0);
  const blocks = Array.from({ length: 9 }, () => pool.allocate(256));
  for (const block of blocks) block[Symbol.dispose]();
  self.postMessage({ lease: shared.workerLease });
  await new Promise(() => {});
};`,
    ], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl, { type: "module" });
  try {
    const staleLease = await new Promise<{ workerId: number; leaseToken: number }>(
      (resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data.lease);
        worker.onerror = (event) => reject(event.error ?? new Error(event.message));
        worker.postMessage({ memory: coordinator.memory });
      },
    );
    const plateau = pool.reservedBytes;
    worker.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(coordinator.reclaimTerminatedWorker(staleLease), "forced lease reclaimed");
    assert(pool.reclaimTerminatedWorker(staleLease) > 0, "forced worker cache recovered");

    using replacement = await SharedBuffer.attach(coordinator.memory);
    const replacementPool = SharedBlockPool.attach(replacement, 0);
    const reused = Array.from({ length: 9 }, () => replacementPool.allocate(256));
    assert(pool.reservedBytes === plateau, "forced recovery reaches the same plateau");
    for (const block of reused) block[Symbol.dispose]();
  } finally {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("SharedBlockPool reports exhaustion without corrupting live leases", async () => {
  using shared = await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 });
  const pool = SharedBlockPool.initialize(shared, 0);
  const blocks = [];
  try {
    while (true) {
      const block = pool.tryAllocate(4_096);
      if (block === undefined) break;
      blocks.push(block);
    }
    assert(blocks.length > 0, "arena must contain blocks");
    assert(pool.tryAllocate(4_096) === undefined, "exhaustion must be stable");
    assertThrows(() => pool.allocate(4_096), RangeError, "allocate must report exhaustion");
    assert(pool.outstandingBlocks === blocks.length, "live block accounting");
  } finally {
    for (const block of blocks) block[Symbol.dispose]();
  }
});

Deno.test("SharedBlockPool allocates unique blocks across Web Workers and reuses them", async () => {
  const workerCount = 4;
  const blocksPerWorker = 16;
  using shared = await SharedBuffer.create({ initialPages: 3, maximumPages: 3, maxWorkers: 5 });
  const barrierOffset = 0;
  const waitGroupOffset = SHARED_SYNC_BYTE_LENGTH;
  const poolOffset = SHARED_SYNC_BYTE_LENGTH * 2;
  SharedBarrier.initialize(shared, barrierOffset, workerCount);
  const waitGroup = SharedWaitGroup.initialize(shared, waitGroupOffset, workerCount);
  const pool = SharedBlockPool.initialize(shared, poolOffset);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBarrier, SharedBlockPool, SharedBuffer, SharedWaitGroup } from ${
        JSON.stringify(moduleUrl)
      };
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const barrier = SharedBarrier.attach(shared, event.data.barrierOffset);
    const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
    const pool = SharedBlockPool.attach(shared, event.data.poolOffset);
    barrier.arriveAndWait();
    const blocks = Array.from(
      { length: event.data.blocksPerWorker },
      () => pool.allocate(256),
    );
    self.postMessage({ phase: "allocated", pointers: blocks.map(block => block.byteOffset) });
    await new Promise(resolve => self.addEventListener("message", resolve, { once: true }));
    for (const block of blocks) block[Symbol.dispose]();
    waitGroup.done();
    self.postMessage({ phase: "done" });
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  try {
    const allocated = workers.map((worker) =>
      new Promise<number[]>((resolve, reject) => {
        worker.onmessage = (
          event: MessageEvent<{ phase: string; pointers?: number[]; message?: string }>,
        ) => {
          if (event.data.phase === "allocated") resolve(event.data.pointers ?? []);
          else reject(new Error(event.data.message ?? "block pool worker failed"));
        };
        worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      })
    );
    for (const worker of workers) {
      worker.postMessage({
        memory: shared.memory,
        barrierOffset,
        waitGroupOffset,
        poolOffset,
        blocksPerWorker,
      });
    }
    const pointers = (await Promise.all(allocated)).flat();
    assert(new Set(pointers).size === workerCount * blocksPerWorker, "cross-worker uniqueness");
    assert(pool.outstandingBlocks === pointers.length, "cross-worker live accounting");
    const released = workers.map((worker) =>
      new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<{ phase: string; message?: string }>) => {
          if (event.data.phase === "done") resolve();
          else reject(new Error(event.data.message ?? "block pool worker release failed"));
        };
        worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      })
    );
    for (const worker of workers) worker.postMessage("release");
    let timeout: number | undefined;
    try {
      await Promise.race([
        Promise.all(released),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("block pool workers timed out")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await waitGroup.waitAsync();
    assert(pool.outstandingBlocks === 0, "cross-worker releases");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases must return");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});
