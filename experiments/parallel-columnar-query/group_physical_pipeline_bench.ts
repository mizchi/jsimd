import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import type { GroupByAggregate } from "../../packages/olap/src/group_by.ts";
import { I32GroupByU8Pipeline } from "../../packages/olap/src/group_physical_pipeline.ts";

const ROWS = Number(Deno.env.get("JSIMD_PIPELINE_ROWS") ?? 1 << 25);
const PAGE_ROWS = Number(Deno.env.get("JSIMD_PIPELINE_PAGE_ROWS") ?? 65_536);
const WORKERS = Number(Deno.env.get("JSIMD_PIPELINE_WORKERS") ?? 8);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const GROUP_COUNT = 8;
const pageCounts = [1, 4, 16, 32, 64, 128, 256, 512].filter(
  (pages) => pages * PAGE_ROWS <= ROWS,
);

const filter = Int32Array.from({ length: ROWS }, (_, index) => index);
const values = Int32Array.from({ length: ROWS }, (_, index) => (index & 1_023) - 512);
const groups = Uint8Array.from({ length: ROWS }, (_, index) => index & (GROUP_COUNT - 1));
const expected = buildExpected(values, groups, pageCounts);
await using pipeline = await I32GroupByU8Pipeline.create(
  { filter, values, groups },
  { groupCount: GROUP_COUNT, workerCount: WORKERS, pageRows: PAGE_ROWS },
);
const measurements = [];
const decisions: Record<string, string | number> = {};
let correctnessChecks = 0;
let plannerMatchesFastest = 0;
let plannerWithinFivePercent = 0;
let sink = 0n;

for (const pages of pageCounts) {
  const maximum = pages * PAGE_ROWS;
  const expectedGroups = expected.get(pages)!;
  const direct = await pipeline.aggregateBetween(0, maximum, { execution: "direct" });
  const workers = await pipeline.aggregateBetween(0, maximum, { execution: "workers" });
  const automatic = await pipeline.aggregateBetween(0, maximum);
  for (
    const [name, result] of [["direct", direct], ["workers", workers], ["auto", automatic]] as const
  ) {
    validate(result.groups, expectedGroups, `${name}/${pages}`);
    correctnessChecks++;
  }

  const directSamples = await measureAsync(async () => {
    sink ^= checksum((await pipeline.aggregateBetween(0, maximum, { execution: "direct" })).groups);
  });
  const workerSamples = await measureAsync(async () => {
    sink ^= checksum(
      (await pipeline.aggregateBetween(0, maximum, { execution: "workers" })).groups,
    );
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
    Math.max(directSummary.medianMs, workerSummary.medianMs) / fastestMs,
  );
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/group-by-physical-pipeline-crossover",
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
      groupCount: GROUP_COUNT,
    },
    bytes: filter.byteLength + values.byteLength + groups.byteLength,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "direct, Worker, and automatic execution returned identical group states",
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
    "The three columns and persistent Worker pool are resident before timing.",
    "The operator performs a range filter followed by eight-group count/sum/min/max.",
    "Sorted filter values make each half-open predicate retain an exact page prefix.",
    "The group-by profile is intentionally independent from count+sum calibration.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_GROUP_PIPELINE_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function buildExpected(
  inputValues: Int32Array,
  inputGroups: Uint8Array,
  targets: readonly number[],
): Map<number, readonly GroupByAggregate[]> {
  const counts = new Uint32Array(GROUP_COUNT);
  const sums = Array<bigint>(GROUP_COUNT).fill(0n);
  const minimums = new Int32Array(GROUP_COUNT).fill(0x7fff_ffff);
  const maximums = new Int32Array(GROUP_COUNT).fill(-0x8000_0000);
  const output = new Map<number, readonly GroupByAggregate[]>();
  let targetIndex = 0;
  for (let row = 0; row < inputValues.length && targetIndex < targets.length; row++) {
    const group = inputGroups[row]!;
    const value = inputValues[row]!;
    counts[group]++;
    sums[group] = sums[group]! + BigInt(value);
    if (value < minimums[group]!) minimums[group] = value;
    if (value > maximums[group]!) maximums[group] = value;
    if (row + 1 !== targets[targetIndex]! * PAGE_ROWS) continue;
    output.set(
      targets[targetIndex]!,
      Array.from({ length: GROUP_COUNT }, (_, key) => ({
        group: key,
        count: counts[key]!,
        sum: sums[key]!,
        min: minimums[key]!,
        max: maximums[key]!,
      })),
    );
    targetIndex++;
  }
  return output;
}

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

function validate(
  actual: readonly GroupByAggregate[],
  expectedGroups: readonly GroupByAggregate[],
  name: string,
): void {
  if (actual.length !== expectedGroups.length) throw new Error(`${name}: group count mismatch`);
  for (let index = 0; index < actual.length; index++) {
    const left = actual[index]!;
    const right = expectedGroups[index]!;
    if (
      left.group !== right.group || left.count !== right.count || left.sum !== right.sum ||
      left.min !== right.min || left.max !== right.max
    ) throw new Error(`${name}: aggregate mismatch for group ${right.group}`);
  }
}

function checksum(groups: readonly GroupByAggregate[]): bigint {
  let value = 0n;
  for (const group of groups) value ^= group.sum ^ BigInt(group.count) ^ BigInt(group.group);
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
