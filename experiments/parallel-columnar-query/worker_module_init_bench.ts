import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { SharedBuffer } from "@mizchi/jsimd-shared";
import {
  compileOlapWorkerModules,
  type OlapWorkerModules,
} from "../../packages/olap/src/runtime_modules.ts";

const WARMUPS = Number(Deno.env.get("JSIMD_INIT_WARMUPS") ?? 3);
const SAMPLES = Number(Deno.env.get("JSIMD_INIT_SAMPLES") ?? 11);
const workerCounts = [1, 2, 4, 8];

const compileStart = performance.now();
const modules = await compileOlapWorkerModules();
const coordinatorCompileMs = performance.now() - compileStart;
const measurements = [];
const metrics: Record<string, number> = { coordinatorCompileMs };

for (const workerCount of workerCounts) {
  const perWorker = await measure(() => startWorkers(workerCount));
  const cloned = await measure(() => startWorkers(workerCount, modules));
  const perWorkerSummary = summarizeBenchmarkSamples(
    `per-worker-compile/${workerCount}-workers`,
    "construction-inclusive",
    perWorker,
  );
  const clonedSummary = summarizeBenchmarkSamples(
    `coordinator-module-clone/${workerCount}-workers`,
    "construction-inclusive",
    cloned,
  );
  measurements.push(perWorkerSummary, clonedSummary);
  metrics[`speedup_${workerCount}_workers`] = round(
    perWorkerSummary.medianMs / clonedSummary.medianMs,
  );
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/worker-module-initialization",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: { workerCounts, modules: 2 },
  },
  correctness: {
    passed: true,
    checks: workerCounts.length * 2 * (WARMUPS + SAMPLES),
    summary: "every Worker instantiated both shared-memory Wasm modules and reported ready",
  },
  measurements,
  metrics,
  notes: [
    "Each sample creates fresh module Workers and waits until both Wasm instances are ready.",
    "The per-Worker baseline compiles both modules independently inside every new Worker realm.",
    "The clone path excludes the separately reported one-time coordinator compilation.",
    "Shared memory construction and Worker module loading are included in both paths.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_INIT_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

async function measure(operation: () => Promise<void>): Promise<number[]> {
  for (let warmup = 0; warmup < WARMUPS; warmup++) await operation();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return samples;
}

async function startWorkers(
  workerCount: number,
  workerModules?: OlapWorkerModules,
): Promise<void> {
  using shared = await SharedBuffer.create({
    maxWorkers: workerCount + 1,
    module: modules.shared,
  });
  const workers = Array.from(
    { length: workerCount },
    () =>
      new Worker(new URL("./worker_module_init_worker.ts", import.meta.url), { type: "module" }),
  );
  try {
    await Promise.all(
      workers.map((worker) => waitUntilReady(worker, shared.memory, workerModules)),
    );
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

function waitUntilReady(
  worker: Worker,
  memory: WebAssembly.Memory,
  workerModules?: OlapWorkerModules,
): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (
      event: MessageEvent<{ readonly ready?: boolean; readonly error?: string }>,
    ) => {
      if (event.data.error !== undefined) reject(new Error(event.data.error));
      else if (event.data.ready === true) resolve();
      else reject(new Error("Worker returned an invalid initialization response"));
    };
    worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    worker.postMessage({
      memory,
      ...(workerModules === undefined ? {} : { modules: workerModules }),
    });
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
