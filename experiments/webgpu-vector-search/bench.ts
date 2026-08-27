import { BlockedVectorArray } from "../../packages/jsimd/src/blocked-vector-array/mod.ts";
import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { WebGpuVectorSearch } from "./gpu_index.ts";

const DIMENSIONS = Number(Deno.env.get("JSIMD_WEBGPU_DIMENSIONS") ?? 128);
const ROW_COUNTS = (Deno.env.get("JSIMD_WEBGPU_ROWS") ?? "1024,4096,16384,65536,262144")
  .split(",")
  .map(Number);
const K = Number(Deno.env.get("JSIMD_WEBGPU_K") ?? 10);
const BATCH_SIZES = (Deno.env.get("JSIMD_WEBGPU_BATCHES") ?? "1,4,16,64,128").split(",").map(
  Number,
);
const WARMUPS = Number(Deno.env.get("JSIMD_WEBGPU_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_WEBGPU_SAMPLES") ?? 15);

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter is available");

const initialized = performance.now();
await using search = await WebGpuVectorSearch.create({
  adapter,
  maxK: K,
  maxBatchSize: Math.max(...BATCH_SIZES),
});
const pipelineInitMs = performance.now() - initialized;
const maxRows = Math.max(...ROW_COUNTS);
const allValues = makeValues(maxRows, DIMENSIONS);
const measurements: BenchmarkMeasurement[] = [];
const rowSummaries: Measurement[] = [];
let correctnessChecks = 0;

for (const rows of ROW_COUNTS) {
  if (!Number.isSafeInteger(rows) || rows < K) throw new RangeError(`invalid row count: ${rows}`);
  const values = allValues.subarray(0, rows * DIMENSIONS);
  const query = values.slice(0, DIMENSIONS);
  using wasm = BlockedVectorArray.from(values, rows, DIMENSIONS);
  using gpu = search.upload(values, rows, DIMENSIONS);
  const wasmIds = new Uint32Array(K);
  const wasmDistances = new Float32Array(K);
  wasm.topKInto(query, wasmIds, wasmDistances);
  const gpuResult = await gpu.topK(query, K);
  assertSameIds(wasmIds, gpuResult.ids);

  const wasmDurations = measureSync(() => wasm.topKInto(query, wasmIds, wasmDistances));
  const residentDurations = await measureAsync(() => gpu.topK(query, K));
  const profiles = await collectProfiles(() => gpu.profileTopK(query, K));
  const uploadDurations = await measureAsync(async () => {
    using oneShot = search.upload(values, rows, DIMENSIONS);
    await oneShot.topK(query, K);
  });
  measurements.push(
    summarizeBenchmarkSamples(`wasm-resident/rows=${rows}/queries=1`, "resident", wasmDurations),
    summarizeBenchmarkSamples(
      `webgpu-resident/rows=${rows}/queries=1`,
      "resident",
      residentDurations,
    ),
    summarizeBenchmarkSamples(
      `webgpu-profiled-dispatch/rows=${rows}/queries=1`,
      "resident",
      profiles.map((value) => value.dispatchMs),
    ),
    summarizeBenchmarkSamples(
      `webgpu-profiled-readback/rows=${rows}/queries=1`,
      "resident",
      profiles.map((value) => value.readbackMs),
    ),
    summarizeBenchmarkSamples(
      `webgpu-profiled-total/rows=${rows}/queries=1`,
      "resident",
      profiles.map((value) => value.totalMs),
    ),
    summarizeBenchmarkSamples(
      `webgpu-upload-query/rows=${rows}/queries=1`,
      "end-to-end",
      uploadDurations,
    ),
  );
  const batches: BatchMeasurement[] = [];
  for (const queryCount of BATCH_SIZES) {
    const queries = makeQueries(values, rows, DIMENSIONS, queryCount);
    const batchIds = new Uint32Array(queryCount * K);
    const batchDistances = new Float32Array(queryCount * K);
    const runWasmBatch = () => {
      for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
        wasm.topKInto(
          queries.subarray(queryIndex * DIMENSIONS, (queryIndex + 1) * DIMENSIONS),
          batchIds.subarray(queryIndex * K, (queryIndex + 1) * K),
          batchDistances.subarray(queryIndex * K, (queryIndex + 1) * K),
        );
      }
    };
    runWasmBatch();
    const batchResult = await gpu.topKBatch(queries, queryCount, K);
    assertSameIds(batchIds, batchResult.ids);
    const wasmBatchDurations = measureSync(runWasmBatch);
    const gpuBatchDurations = await measureAsync(() => gpu.topKBatch(queries, queryCount, K));
    const wasmBatchMedian = percentile(wasmBatchDurations, 0.5);
    const gpuBatchMedian = percentile(gpuBatchDurations, 0.5);
    batches.push({
      queryCount,
      resultReadbackBytes: queryCount * K * 8,
      wasmMedianMs: round(wasmBatchMedian),
      webgpuMedianMs: round(gpuBatchMedian),
      webgpuPerQueryMedianMs: round(gpuBatchMedian / queryCount),
      speedupVsWasm: round(wasmBatchMedian / gpuBatchMedian),
    });
    measurements.push(
      summarizeBenchmarkSamples(
        `wasm-batch-resident/rows=${rows}/queries=${queryCount}`,
        "resident",
        wasmBatchDurations,
      ),
      summarizeBenchmarkSamples(
        `webgpu-batch-resident/rows=${rows}/queries=${queryCount}`,
        "resident",
        gpuBatchDurations,
      ),
    );
  }

  const wasmMedian = percentile(wasmDurations, 0.5);
  const residentMedian = percentile(residentDurations, 0.5);
  const uploadMedian = percentile(uploadDurations, 0.5);
  rowSummaries.push({
    rows,
    inputMiB: round(values.byteLength / 1024 / 1024),
    wasmResidentMiB: round(wasm.residentBytes / 1024 / 1024),
    gpuResidentMiB: round(gpu.residentBytes / 1024 / 1024),
    wasm: summarize(wasmDurations),
    webgpuResident: {
      ...summarize(residentDurations),
      speedupVsWasm: round(wasmMedian / residentMedian),
    },
    webgpuProfiled: {
      dispatchSyncMedianMs: round(percentile(profiles.map((value) => value.dispatchMs), 0.5)),
      readbackMedianMs: round(percentile(profiles.map((value) => value.readbackMs), 0.5)),
      totalMedianMs: round(percentile(profiles.map((value) => value.totalMs), 0.5)),
    },
    webgpuUploadEachQuery: {
      ...summarize(uploadDurations),
      speedupVsWasm: round(wasmMedian / uploadMedian),
    },
    batches,
  });
}

const residentRows = firstWinningRow(rowSummaries, "webgpuResident");
const uploadEachQueryRows = firstWinningRow(rowSummaries, "webgpuUploadEachQuery");
const metrics: Record<string, number | string | boolean> = {
  pipelineInitMs: round(pipelineInitMs),
  crossoverResidentRows: residentRows ?? "none",
  crossoverUploadEachQueryRows: uploadEachQueryRows ?? "none",
};
for (const queryCount of BATCH_SIZES) {
  metrics[`crossoverBatchRowsQ${queryCount}`] = rowSummaries.find((measurement) =>
    measurement.batches.find((batch) =>
      batch.queryCount === queryCount && batch.webgpuMedianMs < batch.wasmMedianMs
    )
  )?.rows ?? "none";
}
for (const summary of rowSummaries) {
  metrics[`wasmResidentMiBRows${summary.rows}`] = summary.wasmResidentMiB;
  metrics[`gpuResidentMiBRows${summary.rows}`] = summary.gpuResidentMiB;
}
const result = createBenchmarkResult({
  name: "webgpu-vector-search/deno-crossover-matrix",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: {
      description: adapter.info.description || "WebGPU adapter",
      ...(adapter.info.vendor ? { vendor: adapter.info.vendor } : {}),
      ...(adapter.info.architecture ? { architecture: adapter.info.architecture } : {}),
      ...(adapter.info.device ? { device: adapter.info.device } : {}),
    },
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      rows: ROW_COUNTS,
      dimensions: DIMENSIONS,
      batchSizes: BATCH_SIZES,
      k: K,
    },
    bytes: allValues.byteLength,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "every WebGPU top-k result matched BlockedVectorArray IDs",
  },
  measurements,
  metrics,
  notes: [
    "Resident measurements include query upload, GPU scheduling, exact top-k, final readback, and typed-array materialization.",
    "Upload-query measurements additionally include row-to-dimension-major conversion and GPU index upload.",
    "Profiled readback inserts an extra synchronization point and must not be added to production resident latency.",
    "Deno requires --unstable-webgpu for this recorded path.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_WEBGPU_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

interface Summary {
  readonly medianMs: number;
  readonly p95Ms: number;
}

interface Measurement {
  readonly rows: number;
  readonly inputMiB: number;
  readonly wasmResidentMiB: number;
  readonly gpuResidentMiB: number;
  readonly wasm: Summary;
  readonly webgpuResident: Summary & { readonly speedupVsWasm: number };
  readonly webgpuProfiled: {
    readonly dispatchSyncMedianMs: number;
    readonly readbackMedianMs: number;
    readonly totalMedianMs: number;
  };
  readonly webgpuUploadEachQuery: Summary & { readonly speedupVsWasm: number };
  readonly batches: readonly BatchMeasurement[];
}

interface BatchMeasurement {
  readonly queryCount: number;
  readonly resultReadbackBytes: number;
  readonly wasmMedianMs: number;
  readonly webgpuMedianMs: number;
  readonly webgpuPerQueryMedianMs: number;
  readonly speedupVsWasm: number;
}

function makeValues(rows: number, dimensions: number): Float32Array {
  const values = new Float32Array(rows * dimensions);
  let random = 0x9e37_79b9;
  for (let index = 0; index < values.length; index++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    values[index] = (random >>> 8) / 0x80_0000 - 1;
  }
  return values;
}

function makeQueries(
  values: Float32Array,
  rows: number,
  dimensions: number,
  queryCount: number,
): Float32Array {
  const queries = new Float32Array(queryCount * dimensions);
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
    const row = Math.imul(queryIndex, 9_973) % rows;
    queries.set(
      values.subarray(row * dimensions, (row + 1) * dimensions),
      queryIndex * dimensions,
    );
  }
  return queries;
}

function measureSync(operation: () => void): number[] {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    operation();
    if (sample >= 0) durations.push(performance.now() - started);
  }
  return durations;
}

async function measureAsync(operation: () => Promise<unknown>): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    await operation();
    if (sample >= 0) durations.push(performance.now() - started);
  }
  return durations;
}

async function collectProfiles(
  operation: () => Promise<{ dispatchMs: number; readbackMs: number; totalMs: number }>,
): Promise<{ dispatchMs: number; readbackMs: number; totalMs: number }[]> {
  const profiles = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const profile = await operation();
    if (sample >= 0) profiles.push(profile);
  }
  return profiles;
}

function summarize(values: readonly number[]): Summary {
  return {
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function firstWinningRow(
  values: readonly Measurement[],
  key: "webgpuResident" | "webgpuUploadEachQuery",
): number | null {
  return values.find((measurement) => measurement[key].medianMs < measurement.wasm.medianMs)
    ?.rows ??
    null;
}

function assertSameIds(expected: Uint32Array, actual: Uint32Array): void {
  if (expected.length !== actual.length) throw new Error("top-k lengths differ");
  for (let rank = 0; rank < expected.length; rank++) {
    if (expected[rank] !== actual[rank]) {
      throw new Error(`WebGPU top-k differs from Wasm at rank ${rank}`);
    }
  }
  correctnessChecks++;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
