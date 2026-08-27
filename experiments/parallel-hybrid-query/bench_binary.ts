import { createEmbeddingWorkload, type EmbeddingDistribution } from "./embedding_workloads.ts";
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
const DISTRIBUTIONS = requestedDistributions();

const measurements: Record<string, unknown>[] = [];
const workloads: Record<string, unknown>[] = [];

for (const distribution of DISTRIBUTIONS) {
  const workload = createEmbeddingWorkload({
    distribution,
    rows: ROWS,
    dimensions: DIMENSIONS,
    queryCount: QUERY_COUNT,
  });
  const initialized = performance.now();
  await using index = await ParallelHybridVectorIndex.create(
    workload.filters,
    workload.vectors,
    DIMENSIONS,
    {
      workerCount: WORKERS,
      maxK: K,
      maxCandidateMultiplier: Math.max(...MULTIPLIERS),
    },
  );
  workloads.push({
    distribution,
    initMs: round(performance.now() - initialized),
    diagnostics: roundDiagnostics(workload.diagnostics),
  });

  for (const selectivity of [0.01, 0.1, 1]) {
    const maximum = Math.round(selectivity * 1_000);
    const references = [];
    for (const query of workload.queries) {
      references.push(await index.searchBetween(query, 0, maximum, { k: K }));
    }
    const exactDurations = await measureBatch(workload.queries, async (query) => {
      await index.searchBetween(query, 0, maximum, { k: K });
    });
    measurements.push({
      distribution,
      selectivity,
      mode: "exact-pdx64",
      medianMs: round(percentile(exactDurations, 0.5)),
      p95Ms: round(percentile(exactDurations, 0.95)),
      recallAtK: 1,
    });

    for (const candidateMultiplier of MULTIPLIERS) {
      const actual = [];
      for (const query of workload.queries) {
        actual.push(
          await index.searchBetweenBinaryRerank(query, 0, maximum, {
            k: K,
            candidateMultiplier,
          }),
        );
      }
      const durations = await measureBatch(workload.queries, async (query) => {
        await index.searchBetweenBinaryRerank(query, 0, maximum, {
          k: K,
          candidateMultiplier,
        });
      });
      measurements.push({
        distribution,
        selectivity,
        mode: "binary-rerank",
        candidateMultiplier,
        medianMs: round(percentile(durations, 0.5)),
        p95Ms: round(percentile(durations, 0.95)),
        speedupVsExact: round(
          percentile(exactDurations, 0.5) / percentile(durations, 0.5),
        ),
        recallAtK: round(meanRecall(references, actual)),
      });
    }
  }
}

const report = {
  runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
  configuration: {
    rows: ROWS,
    dimensions: DIMENSIONS,
    workers: WORKERS,
    queries: QUERY_COUNT,
    k: K,
    warmups: WARMUPS,
    samples: SAMPLES,
    distributions: DISTRIBUTIONS,
  },
  workloads,
  measurements,
};
const reportJson = JSON.stringify(report, null, 2) + "\n";
const output = Deno.env.get("JSIMD_BINARY_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, reportJson);
console.log(reportJson);

async function measureBatch(
  queries: readonly Float32Array[],
  operation: (query: Float32Array) => Promise<void>,
): Promise<number[]> {
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

function roundDiagnostics(diagnostics: {
  readonly meanNorm: number;
  readonly signOneRate: number;
  readonly dominantDimensionVarianceShare: number;
}): Record<string, number> {
  return {
    meanNorm: round(diagnostics.meanNorm),
    signOneRate: round(diagnostics.signOneRate),
    dominantDimensionVarianceShare: round(diagnostics.dominantDimensionVarianceShare),
  };
}

function requestedDistributions(): readonly EmbeddingDistribution[] {
  const requested = Deno.env.get("JSIMD_BINARY_DISTRIBUTION");
  if (requested === undefined) {
    return ["isotropic-unit", "clustered-anisotropic", "mean-shifted"];
  }
  if (
    requested === "isotropic-unit" || requested === "clustered-anisotropic" ||
    requested === "mean-shifted"
  ) return [requested];
  throw new RangeError(`unknown JSIMD_BINARY_DISTRIBUTION ${JSON.stringify(requested)}`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
