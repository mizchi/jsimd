import { createEmbeddingWorkload, type EmbeddingDistribution } from "./embedding_workloads.ts";
import { ParallelHybridVectorIndex } from "./parallel_index.ts";
import {
  type BenchmarkMeasurement,
  summarizeBenchmarkSamples,
} from "../../tools/benchmark/measure.ts";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "../../tools/benchmark/result.ts";

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

const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number | string | boolean> = {};
let correctnessChecks = 0;

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
  metrics[`${distribution}/initMs`] = round(performance.now() - initialized);
  for (const [key, value] of Object.entries(roundDiagnostics(workload.diagnostics))) {
    metrics[`${distribution}/${key}`] = value;
  }

  for (const selectivity of [0.01, 0.1, 1]) {
    const maximum = Math.round(selectivity * 1_000);
    const references = [];
    for (const query of workload.queries) {
      references.push(await index.searchBetween(query, 0, maximum, { k: K }));
    }
    const exactDurations = await measureBatch(workload.queries, async (query) => {
      await index.searchBetween(query, 0, maximum, { k: K });
    });
    measurements.push(summarizeBenchmarkSamples(
      `${distribution}/selectivity=${selectivity}/exact-pdx64`,
      "resident",
      exactDurations,
    ));
    metrics[`${distribution}/selectivity=${selectivity}/exactRecallAtK`] = 1;
    correctnessChecks += references.length;

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
      const name =
        `${distribution}/selectivity=${selectivity}/binary-rerank-${candidateMultiplier}x`;
      measurements.push(summarizeBenchmarkSamples(name, "resident", durations));
      metrics[`${name}/speedupVsExact`] = round(
        percentile(exactDurations, 0.5) / percentile(durations, 0.5),
      );
      metrics[`${name}/recallAtK`] = round(meanRecall(references, actual));
      correctnessChecks += actual.length;
    }
  }
}

const report = createBenchmarkResult({
  name: "parallel-hybrid-query/binary-rerank",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: "unavailable",
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: QUERY_COUNT },
  input: {
    shape: {
      rows: ROWS,
      dimensions: DIMENSIONS,
      workers: WORKERS,
      queries: QUERY_COUNT,
      k: K,
      candidateMultipliers: [...MULTIPLIERS],
      distributions: DISTRIBUTIONS.join(","),
    },
    bytes: ROWS * DIMENSIONS * Float32Array.BYTES_PER_ELEMENT * DISTRIBUTIONS.length,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary:
      "Exact references completed and every approximate result produced a measured Recall@k.",
  },
  measurements,
  metrics,
  notes: [
    "Measurements are per-query latency from batches of fixed deterministic queries.",
    "Index construction is excluded from resident measurements and reported in metrics.",
  ],
});
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
