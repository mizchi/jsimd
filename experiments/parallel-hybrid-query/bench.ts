import { type HybridPlan, ParallelHybridVectorIndex } from "./parallel_index.ts";

const ROWS = Number(Deno.env.get("JSIMD_HYBRID_ROWS") ?? 65_536);
const DIMENSIONS = Number(Deno.env.get("JSIMD_HYBRID_DIMENSIONS") ?? 64);
const WORKERS = Number(
  Deno.env.get("JSIMD_HYBRID_WORKERS") ?? Math.min(4, navigator.hardwareConcurrency || 1),
);
const WARMUPS = Number(Deno.env.get("JSIMD_HYBRID_WARMUPS") ?? 3);
const SAMPLES = Number(Deno.env.get("JSIMD_HYBRID_SAMPLES") ?? 7);
const K = 10;

const filters = new Int32Array(ROWS);
const vectors = new Float32Array(ROWS * DIMENSIONS);
let random = 0x1234_5678;
for (let row = 0; row < ROWS; row++) {
  filters[row] = row % 1_000;
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    vectors[row * DIMENSIONS + dimension] = (random >>> 8) / 0x100_0000;
  }
}
const query = vectors.slice(
  Math.floor(ROWS / 2) * DIMENSIONS,
  (Math.floor(ROWS / 2) + 1) * DIMENSIONS,
);

const initialized = performance.now();
await using index = await ParallelHybridVectorIndex.create(filters, vectors, DIMENSIONS, {
  workerCount: WORKERS,
  maxK: K,
});
const initMs = performance.now() - initialized;
const measurements = [];

for (const selectivity of [0.01, 0.1, 1]) {
  const maximum = Math.round(selectivity * 1_000);
  let reference = "";
  for (const plan of ["filter-first", "vector-first"] satisfies HybridPlan[]) {
    const durations = await measure(async () => {
      const result = await index.searchBetween(query, 0, maximum, { k: K, plan });
      const ids = result.ids.join(",");
      if (reference === "") reference = ids;
      else if (ids !== reference) throw new Error(`${plan} disagreed with the exact result`);
    });
    measurements.push({
      selectivity,
      plan,
      medianMs: round(percentile(durations, 0.5)),
      p95Ms: round(percentile(durations, 0.95)),
    });
  }
}

console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
    workload: { rows: ROWS, dimensions: DIMENSIONS, workers: index.workerCount, k: K },
    initMs: round(initMs),
    measurements,
  },
  null,
  2,
));

async function measure(operation: () => Promise<void>): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    await operation();
    if (sample >= 0) durations.push(performance.now() - started);
  }
  return durations;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
