import {
  SHARED_SYNC_BYTE_LENGTH,
  SharedBarrier,
  SharedBuffer,
  SharedMutex,
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

Deno.test("shared synchronization layouts are cache-line isolated and attachable", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 2 });
  const mutex = SharedMutex.initialize(shared, 0);
  const barrier = SharedBarrier.initialize(shared, SHARED_SYNC_BYTE_LENGTH, 2);
  const waitGroup = SharedWaitGroup.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 2, 1);

  assert(SharedMutex.attach(shared, 0).byteOffset === mutex.byteOffset, "mutex attach");
  assert(
    SharedBarrier.attach(shared, SHARED_SYNC_BYTE_LENGTH).parties === barrier.parties,
    "barrier attach",
  );
  assert(
    SharedWaitGroup.attach(shared, SHARED_SYNC_BYTE_LENGTH * 2).count === waitGroup.count,
    "wait group attach",
  );
  assertThrows(
    () => SharedMutex.initialize(shared, 4),
    RangeError,
    "synchronization state must be cache-line aligned",
  );
});

Deno.test("SharedMutex enforces ownership and rejects recursive locking", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 2 });
  const mutex = SharedMutex.initialize(shared, 0);
  assert(mutex.tryLock(), "first lock");
  assert(!mutex.tryLock(), "tryLock must report contention");
  assertThrows(() => mutex.lock(), Error, "recursive lock must not deadlock");
  mutex.unlock();
  assert(!mutex.isLocked, "unlock");
  assertThrows(() => mutex.unlock(), Error, "unlock without ownership");
  shared[Symbol.dispose]();
  assertThrows(() => mutex.tryLock(), Error, "synchronization view must follow its lease");
});

Deno.test("SharedMutex recovers ownership left by a terminated worker generation", async () => {
  using coordinator = await SharedBuffer.create({ maxWorkers: 2 });
  const terminated = await SharedBuffer.attach(coordinator.memory);
  const mutex = SharedMutex.initialize(terminated, 0);
  assert(mutex.tryLock(), "terminated worker acquires mutex");

  assert(
    coordinator.reclaimTerminatedWorker(terminated.workerLease),
    "coordinator reclaims terminated worker",
  );
  using replacement = await SharedBuffer.attach(coordinator.memory);
  const recovered = SharedMutex.attach(replacement, 0);
  assert(recovered.tryLock(), "replacement generation recovers stale mutex");
  recovered.unlock();
});

Deno.test("shared synchronization exposes non-blocking main-thread waits", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const mutex = SharedMutex.initialize(owner, 0);
  const contender = SharedMutex.attach(attached, 0);
  mutex.lock();
  const acquired = contender.lockAsync();
  setTimeout(() => mutex.unlock(), 0);
  await acquired;
  contender.unlock();

  const barrierOffset = SHARED_SYNC_BYTE_LENGTH;
  const first = SharedBarrier.initialize(owner, barrierOffset, 2);
  const second = SharedBarrier.attach(attached, barrierOffset);
  const firstArrival = first.arriveAndWaitAsync();
  const secondArrival = new Promise<void>((resolve, reject) => {
    setTimeout(() => second.arriveAndWaitAsync().then(resolve, reject), 0);
  });
  await Promise.all([firstArrival, secondArrival]);
});

Deno.test("Mutex, Barrier, and WaitGroup coordinate contended Web Workers", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 5 });
  const workerCount = 4;
  const iterations = 1_000;
  const mutexOffset = 0;
  const barrierOffset = SHARED_SYNC_BYTE_LENGTH;
  const waitGroupOffset = SHARED_SYNC_BYTE_LENGTH * 2;
  const counterOffset = SHARED_SYNC_BYTE_LENGTH * 3;
  SharedMutex.initialize(shared, mutexOffset);
  SharedBarrier.initialize(shared, barrierOffset, workerCount);
  const waitGroup = SharedWaitGroup.initialize(shared, waitGroupOffset, workerCount);
  const counter = shared.uint32Array(counterOffset, 1);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBuffer, SharedMutex, SharedBarrier, SharedWaitGroup } from ${
        JSON.stringify(moduleUrl)
      };
self.onmessage = async (event) => {
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const mutex = SharedMutex.attach(shared, event.data.mutexOffset);
    const barrier = SharedBarrier.attach(shared, event.data.barrierOffset);
    const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
    const counter = shared.uint32Array(event.data.counterOffset, 1);
    barrier.arriveAndWait();
    for (let index = 0; index < event.data.iterations; index++) {
      mutex.lock();
      counter[0]++;
      mutex.unlock();
    }
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
    const completions = workers.map((worker) =>
      new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<{ phase: string; message?: string }>) => {
          if (event.data.phase === "done") resolve();
          else reject(new Error(event.data.message ?? "shared synchronization worker failed"));
        };
        worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      })
    );
    for (const worker of workers) {
      worker.postMessage({
        memory: shared.memory,
        mutexOffset,
        barrierOffset,
        waitGroupOffset,
        counterOffset,
        iterations,
      });
    }
    let timeout: number | undefined;
    try {
      await Promise.race([
        Promise.all(completions),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("shared synchronization workers timed out")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await waitGroup.waitAsync();
    assert(counter[0] === workerCount * iterations, "mutex must prevent lost updates");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases must return after synchronization");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("SharedWaitGroup prevents a negative count", async () => {
  using shared = await SharedBuffer.create();
  const waitGroup = SharedWaitGroup.initialize(shared, 0);
  assertThrows(() => waitGroup.done(), RangeError, "negative count");
  waitGroup.add(2);
  waitGroup.done();
  assert(waitGroup.count === 1, "count after done");
  waitGroup.done();
  await waitGroup.waitAsync();
});
