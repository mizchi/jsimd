import {
  compileSharedBufferModule,
  SHARED_BUFFER_ABI_VERSION,
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
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

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}

Deno.test("SharedBuffer defines an aligned versioned shared-memory ABI", async () => {
  using shared = await SharedBuffer.create({ initialPages: 1, maximumPages: 2, maxWorkers: 4 });
  assert(shared.memory.buffer instanceof SharedArrayBuffer, "memory must be shared");
  assert(shared.abiVersion === SHARED_BUFFER_ABI_VERSION, "ABI version");
  assert(shared.dataOffset % SHARED_BUFFER_CACHE_LINE_BYTES === 0, "data alignment");
  assert(shared.byteLength === 65_536 - shared.dataOffset, "payload length");
  assert(shared.maximumPages === 2, "maximum pages");
  assert(shared.maxWorkers === 4, "worker capacity");
  assert(shared.workerId === 0, "creator worker ID");
  assert(shared.activeWorkers === 1, "creator lease");
});

Deno.test("SharedBuffer reuses a coordinator-compiled Wasm module", async () => {
  const module = await compileSharedBufferModule();
  using owner = await SharedBuffer.create({ maxWorkers: 2, module });
  using attached = await SharedBuffer.attach(owner.memory, { module });

  assert(owner.activeWorkers === 2, "both leases must use the injected module");
  assert(attached.memory === owner.memory, "attach must preserve shared memory identity");
});

Deno.test("SharedBuffer attaches, releases, and reuses worker leases", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 3 });
  const first = await SharedBuffer.attach(owner.memory);
  const second = await SharedBuffer.attach(owner.memory);
  assert(first.workerId === 1, "first attached worker ID");
  assert(second.workerId === 2, "second attached worker ID");
  assert(owner.activeWorkers === 3, "all leases active");
  await assertRejects(
    () => SharedBuffer.attach(owner.memory),
    RangeError,
    "worker capacity must be bounded",
  );
  first[Symbol.dispose]();
  assert(owner.activeWorkers === 2, "released lease");
  using reused = await SharedBuffer.attach(owner.memory);
  assert(reused.workerId === 1, "released worker ID must be reusable");
  second[Symbol.dispose]();
});

Deno.test("SharedBuffer reclaims a terminated worker without reviving its stale lease", async () => {
  using coordinator = await SharedBuffer.create({ maxWorkers: 2 });
  const terminated = await SharedBuffer.attach(coordinator.memory);
  const staleLease = terminated.workerLease;

  assert(coordinator.reclaimTerminatedWorker(staleLease), "terminated lease must be reclaimed");
  assert(coordinator.activeWorkers === 1, "reclaim decrements active workers");
  assert(terminated.disposed, "reclaimed in-realm lease becomes stale");
  assertThrows(() => terminated.uint8Array(0, 1), Error, "stale lease rejects access");

  using replacement = await SharedBuffer.attach(coordinator.memory);
  assert(replacement.workerId === staleLease.workerId, "worker slot must be reusable");
  assert(replacement.leaseToken !== staleLease.leaseToken, "generation must change on reuse");
  assert(
    !coordinator.reclaimTerminatedWorker(staleLease),
    "stale token cannot reclaim replacement",
  );
  terminated[Symbol.dispose]();
  assert(coordinator.activeWorkers === 2, "stale disposal cannot detach replacement");
});

Deno.test("SharedBuffer imported Wasm kernels operate on the attached memory", async () => {
  using owner = await SharedBuffer.create({ initialPages: 1, maximumPages: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  owner.fillUint32(0, 17, 0x1234_5678);
  assert(
    attached.uint32Array(0, 17).every((value) => value === 0x1234_5678),
    "SIMD fill must be shared",
  );
  const words = attached.uint32Array(0, 1);
  assert(Atomics.add(words, 0, 5) === 0x1234_5678, "atomic add returns old value");
  assert(Atomics.load(owner.uint32Array(0, 1), 0) === 0x1234_567d, "atomic result must be shared");

  const source = owner.uint8Array(128, 35);
  source.set(Uint8Array.from({ length: source.length }, (_, index) => index * 7));
  owner.copyBytesNonOverlapping(256, 128, source.length);
  assert(
    attached.uint8Array(256, source.length).every((value, index) => value === index * 7),
    "SIMD copy must preserve bytes",
  );
  assertThrows(
    () => owner.copyBytesNonOverlapping(129, 128, 16),
    RangeError,
    "overlapping copy must be rejected",
  );
});

Deno.test("SharedBuffer validates foreign memories, alignment, bounds, and disposal", async () => {
  const unshared = new WebAssembly.Memory({ initial: 1 });
  await assertRejects(
    () => SharedBuffer.attach(unshared),
    TypeError,
    "unshared memory must be rejected",
  );
  const foreign = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  await assertRejects(
    () => SharedBuffer.attach(foreign),
    RangeError,
    "foreign header must be rejected",
  );
  const shared = await SharedBuffer.create({ maximumPages: 2 });
  await assertRejects(
    () => SharedBuffer.create({ maxWorkers: 256 }),
    RangeError,
    "lease tokens bound worker capacity",
  );
  assertThrows(
    () => shared.reclaimTerminatedWorker(shared.workerLease),
    RangeError,
    "a live lease cannot reclaim itself",
  );
  assertThrows(() => shared.uint32Array(2, 1), RangeError, "unaligned view must be rejected");
  assertThrows(() => shared.uint8Array(shared.byteLength, 1), RangeError, "bounds must be checked");
  shared[Symbol.dispose]();
  assertThrows(() => shared.uint32Array(0, 1), Error, "disposed lease must reject access");
});

Deno.test("SharedBuffer coordinates atomic updates across Web Workers", async () => {
  using shared = await SharedBuffer.create({ maxWorkers: 5 });
  const workerCount = 4;
  const iterations = 10_000;
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBuffer } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  using shared = await SharedBuffer.attach(event.data.memory);
  const counter = shared.uint32Array(0, 1);
  self.postMessage({ phase: "ready", workerId: shared.workerId });
  await new Promise(resolve => self.addEventListener("message", resolve, { once: true }));
  for (let index = 0; index < event.data.iterations; index++) Atomics.add(counter, 0, 1);
  self.postMessage({ phase: "done", workerId: shared.workerId });
};`,
    ], { type: "text/javascript" }),
  );
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(workerUrl, { type: "module" }),
  );
  try {
    const workerIds = await Promise.all(
      workers.map((worker) =>
        new Promise<number>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<{ phase: string; workerId: number }>) =>
            resolve(event.data.workerId);
          worker.onerror = (event) => reject(event.error ?? new Error(event.message));
          worker.postMessage({ memory: shared.memory, iterations });
        })
      ),
    );
    assert(new Set(workerIds).size === workerCount, "worker IDs must be exclusive");
    await Promise.all(
      workers.map((worker) =>
        new Promise<void>((resolve, reject) => {
          worker.onmessage = () => resolve();
          worker.onerror = (event) => reject(event.error ?? new Error(event.message));
          worker.postMessage("run");
        })
      ),
    );
    assert(
      Atomics.load(shared.uint32Array(0, 1), 0) === workerCount * iterations,
      "atomic updates must not be lost",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases must return on scope exit");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});
