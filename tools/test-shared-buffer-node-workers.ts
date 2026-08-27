import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  MpmcRingBufferU32,
  SHARED_SYNC_BYTE_LENGTH,
  SharedBarrier,
  SharedBlockPool,
  SharedBuffer,
  SharedMutex,
  SharedWaitGroup,
} from "../src/shared-buffer/mod.ts";

const WORKER_COUNT = 4;
const ITERATIONS = 10_000;
const MUTEX_OFFSET = 0;
const BARRIER_OFFSET = SHARED_SYNC_BYTE_LENGTH;
const WAIT_GROUP_OFFSET = SHARED_SYNC_BYTE_LENGTH * 2;
const COUNTER_OFFSET = SHARED_SYNC_BYTE_LENGTH * 3;
const MPMC_OFFSET = SHARED_SYNC_BYTE_LENGTH * 4;
const MPMC_CAPACITY = 16;
const POOL_OFFSET = MPMC_OFFSET + MpmcRingBufferU32.byteLengthFor(MPMC_CAPACITY);

if (isMainThread) await runMain();
else await runWorker();

async function runMain(): Promise<void> {
  using shared = await SharedBuffer.create({ maxWorkers: WORKER_COUNT + 1 });
  SharedMutex.initialize(shared, MUTEX_OFFSET);
  SharedBarrier.initialize(shared, BARRIER_OFFSET, WORKER_COUNT);
  const waitGroup = SharedWaitGroup.initialize(shared, WAIT_GROUP_OFFSET, WORKER_COUNT);
  const queue = MpmcRingBufferU32.initialize(shared, MPMC_OFFSET, MPMC_CAPACITY);
  const pool = SharedBlockPool.initialize(shared, POOL_OFFSET);
  const workers = Array.from(
    { length: WORKER_COUNT },
    () => new Worker(import.meta.filename, { workerData: { memory: shared.memory } }),
  );
  try {
    const workerIds = await Promise.all(workers.map(waitForNumber));
    if (new Set(workerIds).size !== WORKER_COUNT) {
      throw new Error("Node worker IDs were not unique");
    }
    const completed = workers.map(waitForNumber);
    for (const worker of workers) worker.postMessage("run");
    await Promise.all(completed);
    await waitGroup.waitAsync();
    if (pool.outstandingBlocks !== 0) throw new Error("Node worker blocks were not returned");
    if (shared.uint32Array(COUNTER_OFFSET, 1)[0] !== WORKER_COUNT * ITERATIONS) {
      throw new Error("Node worker mutex updates were lost");
    }
    const workerIdsFromQueue = new Uint32Array(WORKER_COUNT);
    if (queue.popMany(workerIdsFromQueue) !== WORKER_COUNT) {
      throw new Error("Node worker MPMC values were not returned");
    }
    if (new Set(workerIdsFromQueue).size !== WORKER_COUNT) {
      throw new Error("Node worker MPMC values were not unique");
    }
    for (let attempt = 0; attempt < 100 && shared.activeWorkers !== 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (shared.activeWorkers !== 1) throw new Error("Node worker leases did not return");
    console.log("SharedBuffer Node Worker smoke passed");
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function runWorker(): Promise<void> {
  if (parentPort === null) throw new Error("SharedBuffer worker has no parent port");
  const memory = (workerData as { memory: WebAssembly.Memory }).memory;
  using shared = await SharedBuffer.attach(memory);
  const mutex = SharedMutex.attach(shared, MUTEX_OFFSET);
  const barrier = SharedBarrier.attach(shared, BARRIER_OFFSET);
  const waitGroup = SharedWaitGroup.attach(shared, WAIT_GROUP_OFFSET);
  const queue = MpmcRingBufferU32.attach(shared, MPMC_OFFSET);
  const pool = SharedBlockPool.attach(shared, POOL_OFFSET);
  const counter = shared.uint32Array(COUNTER_OFFSET, 1);
  parentPort.postMessage(shared.workerId);
  await new Promise<void>((resolve) => parentPort.once("message", () => resolve()));
  barrier.arriveAndWait();
  {
    using block = pool.allocate(256);
    block.uint32Array(0, 1)[0] = shared.workerId;
  }
  for (let index = 0; index < ITERATIONS; index++) {
    mutex.lock();
    counter[0]++;
    mutex.unlock();
  }
  queue.push(shared.workerId);
  waitGroup.done();
  parentPort.postMessage(shared.workerId);
}

function waitForNumber(worker: Worker): Promise<number> {
  return new Promise((resolve, reject) => {
    worker.once("message", (value) => resolve(value as number));
    worker.once("error", reject);
  });
}
