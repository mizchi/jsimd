import { SharedBuffer, SharedSlotMap } from "./mod.ts";

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

Deno.test("SharedSlotMap defines an attachable aligned fixed-payload layout", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const slots = SharedSlotMap.initialize(owner, 0, { capacity: 8, payloadByteLength: 24 });
  const peer = SharedSlotMap.attach(attached, 0);
  assert(slots.capacity === 8 && peer.capacity === 8, "capacity");
  assert(slots.payloadByteLength === 24, "logical payload size");
  assert(slots.slotStride === 32, "SIMD-aligned slot stride");
  assert(slots.dataByteOffset % 64 === 0, "payload alignment");
  assert(slots.byteLength % 64 === 0, "layout alignment");

  using slot = slots.allocate();
  slot.uint32Array(0, 2).set([0x1234_5678, 0xffff_ffff]);
  const view = peer.get(slot.handle);
  if (view === undefined) throw new Error("attached handle lookup");
  assert(view.uint32Array(0, 2)[0] === 0x1234_5678, "shared payload");
  assert(view.uint32Array(0, 2)[1] === 0xffff_ffff, "complete u32 payload");
});

Deno.test("SharedSlotMap rejects stale handles and ABA reuse", async () => {
  using shared = await SharedBuffer.create();
  const slots = SharedSlotMap.initialize(shared, 0, { capacity: 1, payloadByteLength: 16 });
  let staleHandle = 0n;
  let staleView;
  {
    using slot = slots.allocate();
    staleHandle = slot.handle;
    staleView = slots.get(slot.handle);
    if (staleView === undefined) throw new Error("live view");
    staleView.uint8Array()[0] = 7;
  }
  assert(!slots.has(staleHandle), "disposed handle is stale");
  assert(slots.get(staleHandle) === undefined, "stale get");
  assertThrows(() => staleView!.uint8Array(), Error, "retained stale view");
  assert(!slots.release(staleHandle), "stale release");

  using replacement = slots.allocate();
  assert(replacement.index === 0, "slot reused");
  assert(replacement.handle !== staleHandle, "generation changed");
  assert(slots.has(replacement.handle), "replacement live");
});

Deno.test("SharedSlotMap reaches a reuse plateau and reports exhaustion", async () => {
  using shared = await SharedBuffer.create();
  const slots = SharedSlotMap.initialize(shared, 0, { capacity: 64, payloadByteLength: 32 });
  const firstGeneration = new Set<bigint>();
  for (let round = 0; round < 20; round++) {
    const leases = Array.from({ length: slots.capacity }, () => slots.allocate());
    assert(slots.outstandingSlots === slots.capacity, `round ${round} live count`);
    assert(slots.tryAllocate() === undefined, `round ${round} exhaustion`);
    for (const lease of leases) {
      if (round === 0) firstGeneration.add(lease.handle);
      lease[Symbol.dispose]();
    }
    assert(slots.outstandingSlots === 0, `round ${round} released count`);
  }
  assert(firstGeneration.size === slots.capacity, "first generation handles unique");
});

Deno.test("SharedSlotMap allocates unique slots across Web Workers", async () => {
  const workerCount = 4;
  const slotsPerWorker = 32;
  using shared = await SharedBuffer.create({ maxWorkers: workerCount + 1 });
  const slotMapOffset = 0;
  const slots = SharedSlotMap.initialize(shared, slotMapOffset, {
    capacity: workerCount * slotsPerWorker,
    payloadByteLength: 16,
  });
  const moduleUrl = new URL("./mod.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { SharedBuffer, SharedSlotMap } from ${JSON.stringify(moduleUrl)};
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    using shared = await SharedBuffer.attach(event.data.memory);
    const slots = SharedSlotMap.attach(shared, event.data.slotMapOffset);
    const leases = Array.from({ length: event.data.count }, () => slots.allocate());
    for (const lease of leases) lease.uint32Array(0, 1)[0] = shared.workerId;
    self.postMessage({ phase: "allocated", handles: leases.map(lease => lease.handle) });
    await new Promise(resolve => self.addEventListener("message", resolve, { once: true }));
    for (const lease of leases) lease[Symbol.dispose]();
    self.postMessage({ phase: "released" });
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
    const allocations = workers.map((worker) => waitForWorker(worker, "allocated"));
    for (const worker of workers) {
      worker.postMessage({ memory: shared.memory, slotMapOffset, count: slotsPerWorker });
    }
    const handles = (await Promise.all(allocations)).flatMap((message) => message.handles ?? []);
    assert(handles.length === slots.capacity, "all slots allocated");
    assert(new Set(handles).size === slots.capacity, "concurrent handles unique");
    assert(slots.outstandingSlots === slots.capacity, "concurrent live count");
    for (const handle of handles) assert(slots.has(handle), "concurrent handle visible");

    const releases = workers.map((worker) => waitForWorker(worker, "released"));
    for (const worker of workers) worker.postMessage("release");
    await Promise.all(releases);
    assert(slots.outstandingSlots === 0, "concurrent slots released");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shared.activeWorkers === 1, "worker leases returned");
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("SharedSlotMap validates layout, payload views, and disposal", async () => {
  using shared = await SharedBuffer.create();
  assertThrows(
    () => SharedSlotMap.initialize(shared, 0, { capacity: 0, payloadByteLength: 16 }),
    RangeError,
    "positive capacity",
  );
  assertThrows(
    () => SharedSlotMap.initialize(shared, 0, { capacity: 1, payloadByteLength: 0 }),
    RangeError,
    "positive payload",
  );
  const slots = SharedSlotMap.initialize(shared, 0, { capacity: 1, payloadByteLength: 6 });
  const slot = slots.allocate();
  assert(slot.uint32Array().length === 1, "default u32 view excludes partial tail bytes");
  assertThrows(() => slot.uint32Array(0, 2), RangeError, "logical payload bounds");
  slot[Symbol.dispose]();
  assertThrows(() => slot.uint8Array(), Error, "disposed lease");
  shared[Symbol.dispose]();
  assertThrows(() => slots.allocate(), Error, "disposed buffer");
});

interface WorkerMessage {
  readonly phase: string;
  readonly handles?: bigint[];
  readonly message?: string;
}

function waitForWorker(worker: Worker, expectedPhase: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.phase === expectedPhase) resolve(event.data);
      else reject(new Error(event.data.message ?? `expected Worker phase ${expectedPhase}`));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  });
}
