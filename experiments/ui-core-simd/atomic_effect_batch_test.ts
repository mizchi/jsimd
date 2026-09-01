import { AtomicEffectBatch } from "./atomic_effect_batch.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("AtomicEffectBatch deduplicates marks and drains a stable snapshot", () => {
  const owner = AtomicEffectBatch.create(70);
  const peer = AtomicEffectBatch.attach(owner.buffer);
  assert(owner.mark(1), "first mark wins");
  assert(!peer.mark(1), "duplicate mark observes existing bit");
  peer.markMany([0, 31, 32, 69, 32]);
  assert(Array.from(owner.drain()).join(",") === "0,1,31,32,69", "sorted drain");
  assert(owner.drain().length === 0, "drain clears snapshot");
});

Deno.test("AtomicEffectBatch merges concurrent worker producers without lost effect IDs", async () => {
  const effectCount = 257;
  const batch = AtomicEffectBatch.create(effectCount);
  const moduleUrl = new URL("./atomic_effect_batch.ts", import.meta.url).href;
  const workerUrl = URL.createObjectURL(
    new Blob([
      `import { AtomicEffectBatch } from ${JSON.stringify(moduleUrl)};
self.onmessage = (event) => {
  try {
    const batch = AtomicEffectBatch.attach(event.data.buffer);
    batch.markMany(event.data.effectIds);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ ok: false, message: error?.stack ?? String(error) });
  }
};`,
    ], { type: "text/javascript" }),
  );
  const assignments = [
    [0, 1, 31, 32, 200],
    [1, 2, 32, 64, 201],
    [2, 3, 64, 128, 255],
    [0, 3, 128, 200, 256],
  ];
  const workers = assignments.map(() => new Worker(workerUrl, { type: "module" }));
  try {
    await Promise.all(workers.map((worker, index) =>
      runWorker(worker, {
        buffer: batch.buffer,
        effectIds: assignments[index],
      })
    ));
    assert(
      Array.from(batch.drain()).join(",") === "0,1,2,3,31,32,64,128,200,201,255,256",
      "worker union",
    );
  } finally {
    for (const worker of workers) worker.terminate();
    URL.revokeObjectURL(workerUrl);
  }
});

Deno.test("AtomicEffectBatch validates layout and effect IDs", () => {
  const batch = AtomicEffectBatch.create(3);
  assertThrows(() => batch.mark(-1), RangeError);
  assertThrows(() => batch.mark(3), RangeError);
  assertThrows(() => AtomicEffectBatch.attach(new SharedArrayBuffer(64)), RangeError);
});

function runWorker(worker: Worker, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ ok: boolean; message?: string }>) => {
      if (event.data.ok) resolve();
      else reject(new Error(event.data.message ?? "worker failed"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
