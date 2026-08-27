import { AtomicDenseBitmap, SharedBuffer } from "./mod.ts";

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

Deno.test("AtomicDenseBitmap defines an attachable cache-line-aligned fixed universe", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const bitmap = AtomicDenseBitmap.initialize(owner, 0, 131);
  const peer = AtomicDenseBitmap.attach(attached, 0);
  assert(bitmap.capacity === 131 && peer.capacity === 131, "capacity");
  assert(bitmap.wordCount === 5, "logical word count");
  assert(bitmap.dataByteOffset % 64 === 0, "word alignment");
  assert(bitmap.byteLength % 64 === 0, "layout alignment");
  assert(!bitmap.has(0) && !bitmap.has(130), "zero initialization");
  peer.set(0);
  peer.set(31);
  peer.set(32);
  peer.set(130);
  assert(bitmap.has(0) && bitmap.has(31) && bitmap.has(32) && bitmap.has(130), "shared bits");
});

Deno.test("AtomicDenseBitmap point operations return linearized prior state", async () => {
  using shared = await SharedBuffer.create();
  const bitmap = AtomicDenseBitmap.initialize(shared, 0, 65);
  assert(bitmap.testAndSet(17) === false, "first set observes clear");
  assert(bitmap.testAndSet(17) === true, "second set observes set");
  assert(bitmap.testAndClear(17) === true, "first clear observes set");
  assert(bitmap.testAndClear(17) === false, "second clear observes clear");
  bitmap.toggle(17);
  assert(bitmap.has(17), "toggle on");
  bitmap.toggle(17);
  assert(!bitmap.has(17), "toggle off");
  bitmap.set(64);
  bitmap.clear(64);
  assert(!bitmap.has(64), "tail bit clear");
});

Deno.test("AtomicDenseBitmap serializes contended test-and-set and test-and-clear", async () => {
  const workerCount = 4;
  const bit = 37;
  using shared = await SharedBuffer.create({ maxWorkers: workerCount + 1 });
  AtomicDenseBitmap.initialize(shared, 0, 128);
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { AtomicDenseBitmap, SharedBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const bitmap = AtomicDenseBitmap.attach(shared, 0);
    const nextCommand = () => new Promise(resolve =>
      self.addEventListener("message", command => resolve(command.data), { once: true })
    );
    self.postMessage({ phase: "ready" });
    if (await nextCommand() !== "set") throw new Error("expected set command");
    self.postMessage({ phase: "set", previous: bitmap.testAndSet(event.data.bit) });
    if (await nextCommand() !== "clear") throw new Error("expected clear command");
    self.postMessage({ phase: "clear", previous: bitmap.testAndClear(event.data.bit) });
    if (await nextCommand() !== "done") throw new Error("expected done command");
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
    await Promise.all(workers.map((worker) =>
      nextWorkerMessage(worker, "ready", {
        memory: shared.memory,
        bit,
      })
    ));
    const setResults = await Promise.all(
      workers.map((worker) => nextWorkerMessage(worker, "set", "set")),
    );
    assert(setResults.filter((result) => result.previous === false).length === 1, "one set winner");
    const clearResults = await Promise.all(
      workers.map((worker) => nextWorkerMessage(worker, "clear", "clear")),
    );
    assert(
      clearResults.filter((result) => result.previous === true).length === 1,
      "one clear winner",
    );
    await Promise.all(workers.map((worker) => nextWorkerMessage(worker, "done", "done")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases returned");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("AtomicDenseBitmap validates layout, indices, and backing lifetime", async () => {
  const shared = await SharedBuffer.create();
  assertThrows(() => AtomicDenseBitmap.initialize(shared, 4, 64), RangeError, "alignment");
  assertThrows(() => AtomicDenseBitmap.initialize(shared, 0, -1), RangeError, "capacity");
  const bitmap = AtomicDenseBitmap.initialize(shared, 0, 33);
  for (const bit of [-1, 33, 1.5, Number.MAX_SAFE_INTEGER]) {
    assertThrows(() => bitmap.has(bit), RangeError, `invalid bit ${bit}`);
  }
  shared[Symbol.dispose]();
  assertThrows(() => bitmap.has(0), Error, "disposed backing lease");
});

interface WorkerMessage {
  readonly phase: string;
  readonly previous?: boolean;
  readonly message?: string;
}

function nextWorkerMessage(
  worker: Worker,
  phase: string,
  message: unknown,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.phase === "error") {
        reject(new Error(event.data.message ?? "AtomicDenseBitmap worker failed"));
      } else if (event.data.phase === phase) {
        resolve(event.data);
      } else {
        reject(new Error(`unexpected worker phase: ${event.data.phase}`));
      }
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}
