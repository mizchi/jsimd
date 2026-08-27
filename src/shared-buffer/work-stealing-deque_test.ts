import { SharedBarrier, SharedBuffer, WorkStealingDequeU32 } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
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

Deno.test("WorkStealingDequeU32 is LIFO for its owner and FIFO for thieves", async () => {
  using ownerBuffer = await SharedBuffer.create({ maxWorkers: 2 });
  using thiefBuffer = await SharedBuffer.attach(ownerBuffer.memory);
  const deque = WorkStealingDequeU32.initialize(ownerBuffer, 0, 8);
  const thief = WorkStealingDequeU32.attach(thiefBuffer, 0);
  using owner = deque.owner();
  assert(owner.tryPush(10) && owner.tryPush(20) && owner.tryPush(30), "push");
  assert(thief.trySteal() === 10, "thief takes top");
  assert(owner.tryPop() === 30, "owner takes bottom");
  assert(owner.tryPop() === 20, "owner drains last item");
  assert(owner.tryPop() === undefined && thief.trySteal() === undefined, "empty");
});

Deno.test("WorkStealingDequeU32 supports concurrent Web Worker thieves without duplicates", async () => {
  const thiefCount = 4;
  const taskCount = 256;
  using shared = await SharedBuffer.create({ maxWorkers: thiefCount + 1 });
  const deque = WorkStealingDequeU32.initialize(shared, 0, 512);
  const barrierOffset = deque.byteLength;
  const barrier = SharedBarrier.initialize(shared, barrierOffset, thiefCount + 1);
  using owner = deque.owner();
  for (let task = 0; task < taskCount; task++) assert(owner.tryPush(task), `push ${task}`);

  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBarrier, SharedBuffer, WorkStealingDequeU32 } from ${
        JSON.stringify(moduleUrl)
      };
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const deque = WorkStealingDequeU32.attach(shared, 0);
    const barrier = SharedBarrier.attach(shared, event.data.barrierOffset);
    barrier.arriveAndWait();
    const tasks = [];
    while (true) {
      const task = deque.trySteal();
      if (task === undefined) break;
      tasks.push(task);
    }
    self.postMessage({ phase: "done", tasks });
  } catch (error) {
    self.postMessage({ phase: "error", message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const workers = Array.from({ length: thiefCount }, () =>
    new Worker(workerUrl, {
      type: "module",
    }));
  try {
    const completions = workers.map(waitForWorker);
    workers.forEach((worker) => worker.postMessage({ memory: shared.memory, barrierOffset }));
    await barrier.arriveAndWaitAsync();
    const results = await Promise.all(completions);
    const tasks = results.flatMap((result) => result.tasks ?? []).sort((a, b) => a - b);
    assert(tasks.length === taskCount, "all tasks stolen");
    tasks.forEach((task, index) => assert(task === index, `unique task ${index}`));
    assert(owner.tryPop() === undefined, "owner sees drained deque");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("WorkStealingDequeU32 preserves behavior across u32 counter rollover", async () => {
  using shared = await SharedBuffer.create();
  const deque = WorkStealingDequeU32.initialize(shared, 0, 8);
  const top = shared.int32Array(64, 1);
  const bottom = shared.int32Array(128, 1);
  Atomics.store(top, 0, 0xffff_fffe);
  Atomics.store(bottom, 0, 0xffff_fffe);
  using owner = deque.owner();
  assert(owner.tryPush(1) && owner.tryPush(2) && owner.tryPush(3), "rollover pushes");
  assert(owner.tryPop() === 3, "pop after rollover");
  assert(deque.trySteal() === 1 && deque.trySteal() === 2, "steal after rollover");
  assert(deque.trySteal() === undefined, "empty after rollover");
});

Deno.test("WorkStealingDequeU32 validates capacity, values, ownership, and lifetimes", async () => {
  const shared = await SharedBuffer.create();
  assertThrows(() => WorkStealingDequeU32.initialize(shared, 0, 3), RangeError, "power of two");
  assertThrows(() => WorkStealingDequeU32.initialize(shared, 4, 8), RangeError, "alignment");
  const deque = WorkStealingDequeU32.initialize(shared, 0, 2);
  const owner = deque.owner();
  assertThrows(() => deque.owner(), RangeError, "exclusive owner");
  assertThrows(() => owner.tryPush(-1), RangeError, "u32 task");
  assert(owner.tryPush(1) && owner.tryPush(2), "fill");
  assert(!owner.tryPush(3), "bounded capacity");
  owner[Symbol.dispose]();
  assertThrows(() => owner.tryPop(), Error, "disposed owner");
  shared[Symbol.dispose]();
  assertThrows(() => deque.trySteal(), Error, "disposed backing lease");
});

interface WorkerResult {
  readonly phase: string;
  readonly tasks?: number[];
  readonly message?: string;
}

function waitForWorker(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      if (event.data.phase === "done") resolve(event.data);
      else reject(new Error(event.data.message ?? "work-stealing worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
