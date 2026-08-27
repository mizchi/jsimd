import { ParallelHybridVectorIndex } from "./parallel_index.ts";

const ROWS = Number(Deno.env.get("JSIMD_BINARY_ROWS") ?? 65_536);
const DIMENSIONS = Number(Deno.env.get("JSIMD_BINARY_DIMENSIONS") ?? 128);
const WORKERS = Number(
  Deno.env.get("JSIMD_BINARY_WORKERS") ?? Math.min(4, navigator.hardwareConcurrency || 1),
);
const WARMUPS = Number(Deno.env.get("JSIMD_BINARY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_BINARY_SAMPLES") ?? 15);
const QUERY_COUNT = 8;
const K = 10;
const MULTIPLIERS = [2, 4, 8] as const;

const filters = new Int32Array(ROWS);
const vectors = new Float32Array(ROWS * DIMENSIONS);
let random = 0x1234_5678;
for (let row = 0; row < ROWS; row++) {
  filters[row] = row % 1_000;
  let squaredNorm = 0;
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const value = (random >>> 8) / 0x80_0000 - 1;
    vectors[row * DIMENSIONS + dimension] = value;
    squaredNorm += value * value;
  }
  const scale = 1 / Math.sqrt(squaredNorm);
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    vectors[row * DIMENSIONS + dimension] *= scale;
  }
}

const queries = Array.from({ length: QUERY_COUNT }, (_, index) => {
  const sourceRow = 5_000 + index;
  const query = vectors.slice(sourceRow * DIMENSIONS, (sourceRow + 1) * DIMENSIONS);
  let squaredNorm = 0;
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    const noise = ((dimension * 17 + index * 31) % 23 - 11) * 0.0005;
    query[dimension] += noise;
    squaredNorm += query[dimension]! * query[dimension]!;
  }
  const scale = 1 / Math.sqrt(squaredNorm);
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) query[dimension] *= scale;
  return query;
});

const initialized = performance.now();
await using index = await ParallelHybridVectorIndex.create(filters, vectors, DIMENSIONS, {
  workerCount: WORKERS,
  maxK: K,
  maxCandidateMultiplier: Math.max(...MULTIPLIERS),
});
const initMs = performance.now() - initialized;
const measurements = [];

for (const selectivity of [0.01, 0.1, 1]) {
  const maximum = Math.round(selectivity * 1_000);
  const references = [];
  for (const query of queries) {
    references.push(await index.searchBetween(query, 0, maximum, { k: K }));
  }
  const exactDurations = await measureBatch(async (query) => {
    await index.searchBetween(query, 0, maximum, { k: K });
  });
  measurements.push({
    selectivity,
    mode: "exact-pdx64",
    medianMs: round(percentile(exactDurations, 0.5)),
    p95Ms: round(percentile(exactDurations, 0.95)),
    recallAtK: 1,
  });

  for (const candidateMultiplier of MULTIPLIERS) {
    const actual = [];
    for (const query of queries) {
      actual.push(
        await index.searchBetweenBinaryRerank(query, 0, maximum, { k: K, candidateMultiplier }),
      );
    }
    const durations = await measureBatch(async (query) => {
      await index.searchBetweenBinaryRerank(query, 0, maximum, { k: K, candidateMultiplier });
    });
    measurements.push({
      selectivity,
      mode: "binary-rerank",
      candidateMultiplier,
      medianMs: round(percentile(durations, 0.5)),
      p95Ms: round(percentile(durations, 0.95)),
      speedupVsExact: round(percentile(exactDurations, 0.5) / percentile(durations, 0.5)),
      recallAtK: round(meanRecall(references, actual)),
    });
  }
}

console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
    workload: {
      rows: ROWS,
      dimensions: DIMENSIONS,
      workers: index.workerCount,
      queries: QUERY_COUNT,
      k: K,
      warmups: WARMUPS,
      samples: SAMPLES,
    },
    initMs: round(initMs),
    measurements,
  },
  null,
  2,
));

async function measureBatch(operation: (query: Float32Array) => Promise<void>): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    for (const query of queries) await operation(query);
    const perQuery = (performance.now() - started) / queries.length;
    if (sample >= 0) durations.push(perQuery);
  }
  return durations;
}

function meanRecall(
  expected: readonly { readonly ids: Uint32Array }[],
  actual: readonly { readonly ids: Uint32Array }[],
): number {
  let matches = 0;
  let total = 0;
  for (let query = 0; query < expected.length; query++) {
    const found = new Set(actual[query]!.ids);
    for (const id of expected[query]!.ids) matches += Number(found.has(id));
    total += expected[query]!.ids.length;
  }
  return total === 0 ? 1 : matches / total;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
