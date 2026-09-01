import { AtomicEffectBatch } from "./atomic_effect_batch.ts";

const WORKER_COUNT = 4;
const moduleUrl = new URL("./atomic_effect_batch.ts", import.meta.url).href;
const workerUrl = URL.createObjectURL(
  new Blob([
    `import { AtomicEffectBatch } from ${JSON.stringify(moduleUrl)};
let batch;
let effectIds;
self.onmessage = (event) => {
  try {
    if (event.data.type === "init") {
      batch = AtomicEffectBatch.attach(event.data.buffer);
      effectIds = event.data.effectIds;
      self.postMessage({ type: "ready" });
    } else if (event.data.type === "run") {
      batch.markMany(effectIds);
      self.postMessage({ type: "done" });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error?.stack ?? String(error) });
  }
};`,
  ], { type: "text/javascript" }),
);

try {
  console.log("| marks/batch | sequential Atomics | 4 persistent workers | worker/sequential |");
  console.log("|---:|---:|---:|---:|");
  for (const markCount of [1_024, 16_384, 262_144, 1_048_576]) {
    const capacity = Math.max(1_024, markCount >>> 1);
    const assignments = Array.from({ length: WORKER_COUNT }, (_, workerId) =>
      Uint32Array.from(
        { length: Math.ceil(markCount / WORKER_COUNT) },
        (_, index) => (workerId + index * WORKER_COUNT) % capacity,
      ));
    const all = Uint32Array.from(assignments.flatMap((values) => Array.from(values)));
    const sequentialBatch = AtomicEffectBatch.create(capacity);
    const workerBatch = AtomicEffectBatch.create(capacity);
    const workers = assignments.map(() => new Worker(workerUrl, { type: "module" }));
    try {
      await Promise.all(workers.map((worker, index) =>
        request(worker, {
          type: "init",
          buffer: workerBatch.buffer,
          effectIds: assignments[index],
        }, "ready")
      ));
      const sequential = await medianMs(() => {
        sequentialBatch.markMany(all);
        sequentialBatch.drain();
      });
      const parallel = await medianMs(async () => {
        await Promise.all(workers.map((worker) => request(worker, { type: "run" }, "done")));
        workerBatch.drain();
      });
      console.log(
        `| ${markCount.toLocaleString()} | ${sequential.toFixed(3)} ms | ${
          parallel.toFixed(3)
        } ms | ${(parallel / sequential).toFixed(2)}x |`,
      );
    } finally {
      for (const worker of workers) worker.terminate();
    }
  }
} finally {
  URL.revokeObjectURL(workerUrl);
}

async function medianMs(operation: () => void | Promise<void>): Promise<number> {
  for (let index = 0; index < 5; index++) await operation();
  const samples: number[] = [];
  for (let index = 0; index < 15; index++) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return samples[samples.length >>> 1]!;
}

function request(worker: Worker, message: unknown, expectedType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ type: string; message?: string }>) => {
      if (event.data.type === expectedType) resolve();
      else {reject(
          new Error(event.data.message ?? `unexpected worker response: ${event.data.type}`),
        );}
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage(message);
  });
}
