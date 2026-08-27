import { PdxBlockPruningExperiment } from "./pdx_block_pruning.ts";
import {
  type BenchmarkMeasurement,
  summarizeBenchmarkSamples,
} from "../../tools/benchmark/measure.ts";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "../../tools/benchmark/result.ts";

type PhysicalLayout = "clustered-blocks" | "shuffled-clusters";

const ROWS = Number(Deno.env.get("JSIMD_PDX_PRUNING_ROWS") ?? 65_536);
const DIMENSIONS = Number(Deno.env.get("JSIMD_PDX_PRUNING_DIMENSIONS") ?? 128);
const WARMUPS = Number(Deno.env.get("JSIMD_PDX_PRUNING_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_PDX_PRUNING_SAMPLES") ?? 15);
const QUERY_COUNT = 8;
const K = 10;
const layouts: PhysicalLayout[] = ["clustered-blocks", "shuffled-clusters"];
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number | string | boolean> = {};
let correctnessChecks = 0;

for (const layout of layouts) {
  const workload = createWorkload(layout, ROWS, DIMENSIONS, QUERY_COUNT);
  const initialized = performance.now();
  using index = await PdxBlockPruningExperiment.create(workload.vectors, DIMENSIONS, { maxK: K });
  const initMs = performance.now() - initialized;
  const exactResults = workload.queries.map((query) => index.searchExact(query, K));
  const prunedResults = workload.queries.map((query) => index.searchPruned(query, K));
  for (let query = 0; query < QUERY_COUNT; query++) {
    if (exactResults[query]!.ids.join(",") !== prunedResults[query]!.ids.join(",")) {
      throw new Error(`${layout} query ${query} changed exact IDs`);
    }
    correctnessChecks++;
  }
  const exactDurations = measureBatch(workload.queries, (query) => index.searchExact(query, K));
  const prunedDurations = measureBatch(workload.queries, (query) => index.searchPruned(query, K));
  measurements.push(
    summarizeBenchmarkSamples(`${layout}/exact`, "resident", exactDurations),
    summarizeBenchmarkSamples(`${layout}/block-pruned`, "resident", prunedDurations),
  );
  metrics[`${layout}/initMs`] = round(initMs);
  metrics[`${layout}/metadataBytes`] = index.metadataBytes;
  metrics[`${layout}/metadataOverheadPercent`] = round(
    index.metadataBytes / (ROWS * DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) * 100,
  );
  metrics[`${layout}/speedup`] = round(
    percentile(exactDurations, 0.5) / percentile(prunedDurations, 0.5),
  );
  metrics[`${layout}/evaluatedBlockPercent`] = round(
    mean(prunedResults.map((result) => result.evaluatedBlocks)) /
      Math.ceil(ROWS / 64) * 100,
  );
  metrics[`${layout}/evaluatedRowPercent`] = round(
    mean(prunedResults.map((result) => result.evaluatedRows)) / ROWS * 100,
  );
}

const report = createBenchmarkResult({
  name: "parallel-hybrid-query/pdx-block-pruning",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({ adapter: null }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: QUERY_COUNT },
  input: {
    shape: {
      rows: ROWS,
      dimensions: DIMENSIONS,
      queries: QUERY_COUNT,
      k: K,
      layouts: layouts.join(","),
    },
    bytes: ROWS * DIMENSIONS * Float32Array.BYTES_PER_ELEMENT,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "Block-pruned search returned the same IDs as exact search for every query.",
  },
  measurements,
  metrics,
  notes: [
    "Measurements are per-query latency from batches of fixed deterministic queries.",
    "Index construction is excluded from resident measurements and reported in metrics.",
  ],
});
const json = JSON.stringify(report, null, 2) + "\n";
const output = Deno.env.get("JSIMD_PDX_PRUNING_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function createWorkload(
  layout: PhysicalLayout,
  rows: number,
  dimensions: number,
  queryCount: number,
): { readonly vectors: Float32Array; readonly queries: readonly Float32Array[] } {
  if (rows % 64 !== 0) throw new RangeError("benchmark rows must be divisible by 64");
  const blocks = rows / 64;
  const random = createDeterministicRandom(0x9e37_79b9);
  const centroids = new Float32Array(blocks * dimensions);
  for (let block = 0; block < blocks; block++) {
    const centroid = centroids.subarray(block * dimensions, (block + 1) * dimensions);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      centroid[dimension] = random.gaussian();
    }
    normalize(centroid);
  }
  const vectors = new Float32Array(rows * dimensions);
  for (let row = 0; row < rows; row++) {
    const physicalBlock = row >>> 6;
    const cluster = layout === "clustered-blocks" ? physicalBlock : row & 63;
    const centroidOffset = cluster * dimensions;
    const vector = vectors.subarray(row * dimensions, (row + 1) * dimensions);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vector[dimension] = centroids[centroidOffset + dimension]! + random.gaussian() * 0.005;
    }
    normalize(vector);
  }
  const queries = Array.from({ length: queryCount }, (_, index) => {
    const block = Math.min(blocks - 1, Math.floor((index + 0.5) * blocks / queryCount));
    const sourceRow = block * 64 + index;
    return vectors.slice(sourceRow * dimensions, (sourceRow + 1) * dimensions);
  });
  return { vectors, queries };
}

function measureBatch(
  queries: readonly Float32Array[],
  operation: (query: Float32Array) => unknown,
): number[] {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    for (const query of queries) operation(query);
    const perQuery = (performance.now() - started) / queries.length;
    if (sample >= 0) durations.push(perQuery);
  }
  return durations;
}

function normalize(vector: Float32Array): void {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  const scale = 1 / Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index++) vector[index] *= scale;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function createDeterministicRandom(seed: number): { gaussian(): number } {
  let state = seed >>> 0;
  let spare: number | undefined;
  function uniform(): number {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state + 0.5) / 0x1_0000_0000;
  }
  return {
    gaussian(): number {
      if (spare !== undefined) {
        const value = spare;
        spare = undefined;
        return value;
      }
      const first = Math.max(Number.EPSILON, uniform());
      const second = uniform();
      const radius = Math.sqrt(-2 * Math.log(first));
      const angle = 2 * Math.PI * second;
      spare = radius * Math.sin(angle);
      return radius * Math.cos(angle);
    },
  };
}
