import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { I32AggregatePipeline } from "../../packages/olap/src/physical_pipeline.ts";

const ROWS = Number(Deno.env.get("JSIMD_PIPELINE_ROWS") ?? 1 << 25);
const PAGE_ROWS = Number(Deno.env.get("JSIMD_PIPELINE_PAGE_ROWS") ?? 65_536);
const WORKERS = Number(Deno.env.get("JSIMD_PIPELINE_WORKERS") ?? 8);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const pageCounts = [1, 4, 16, 32, 64, 128, 256, 512].filter((pages) => pages * PAGE_ROWS <= ROWS);

const values = Int32Array.from({ length: ROWS }, (_, index) => index);
await using pipeline = await I32AggregatePipeline.create(values, {
  workerCount: WORKERS,
  pageRows: PAGE_ROWS,
});
const measurements = [];
const decisions: Record<string, string | number> = {};
let correctnessChecks = 0;
let plannerMatchesFastest = 0;
let plannerWithinFivePercent = 0;
let sink = 0n;

for (const pages of pageCounts) {
  const maximum = pages * PAGE_ROWS;
  const expectedCount = maximum;
  const expectedSum = BigInt(maximum) * BigInt(maximum - 1) / 2n;
  const direct = await pipeline.aggregateBetween(0, maximum, { execution: "direct" });
  const workers = await pipeline.aggregateBetween(0, maximum, { execution: "workers" });
  const automatic = await pipeline.aggregateBetween(0, maximum);
  for (
    const [name, result] of [["direct", direct], ["workers", workers], ["auto", automatic]] as const
  ) {
    if (result.count !== expectedCount || result.sum !== expectedSum) {
      throw new Error(`${name}/${pages} pages returned an incorrect aggregate`);
    }
    correctnessChecks++;
  }

  const directSamples = await measureAsync(async () => {
    sink ^= (await pipeline.aggregateBetween(0, maximum, { execution: "direct" })).sum;
  });
  const workerSamples = await measureAsync(async () => {
    sink ^= (await pipeline.aggregateBetween(0, maximum, { execution: "workers" })).sum;
  });
  const directSummary = summarizeBenchmarkSamples(
    `direct/${pages}-pages`,
    "resident",
    directSamples,
  );
  const workerSummary = summarizeBenchmarkSamples(
    `workers/${pages}-pages`,
    "resident",
    workerSamples,
  );
  measurements.push(directSummary, workerSummary);
  const fastest = workerSummary.medianMs < directSummary.medianMs ? "workers" : "direct";
  const planned = automatic.plan.execution;
  if (fastest === planned) plannerMatchesFastest++;
  const plannedMs = planned === "workers" ? workerSummary.medianMs : directSummary.medianMs;
  const fastestMs = Math.min(directSummary.medianMs, workerSummary.medianMs);
  if (plannedMs <= fastestMs * 1.05) plannerWithinFivePercent++;
  decisions[`fastest_${pages}_pages`] = fastest;
  decisions[`planned_${pages}_pages`] = planned;
  decisions[`speedup_${pages}_pages`] = round(
    Math.max(directSummary.medianMs, workerSummary.medianMs) /
      Math.min(directSummary.medianMs, workerSummary.medianMs),
  );
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/physical-pipeline-crossover",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      rows: ROWS,
      pageRows: PAGE_ROWS,
      totalPages: Math.ceil(ROWS / PAGE_ROWS),
      survivingPages: pageCounts.join(","),
      workers: WORKERS,
    },
    bytes: values.byteLength,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "direct, Worker, and automatic execution returned identical count and sum",
  },
  measurements,
  metrics: {
    plannerMatchesFastest,
    plannerWithinFivePercent,
    plannerDecisionCount: pageCounts.length,
    ...decisions,
    sink: sink.toString(),
  },
  notes: [
    "The input and persistent Worker pool are resident before timing.",
    "Sorted i32 values make the half-open predicate retain an exact number of 65,536-row pages.",
    "Direct and Worker modes execute the same shared-memory page ABI and SIMD aggregate kernel.",
    "This calibrates count+sum only; a more expensive operator must supply its own page cost.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_PIPELINE_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

async function measureAsync(operation: () => Promise<void>): Promise<number[]> {
  for (let warmup = 0; warmup < WARMUPS; warmup++) await operation();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  return samples;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
