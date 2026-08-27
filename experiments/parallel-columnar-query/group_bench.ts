import {
  type GroupByAggregate,
  groupByBetweenReference,
  ParallelI32GroupByU8Query,
} from "./group_by.ts";

const LENGTH = Number(Deno.env.get("JSIMD_QUERY_ROWS") ?? 8 * 1024 * 1024);
const PAGE_ROWS = 65_536;
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 7);
const WORKERS = Math.min(
  Number(Deno.env.get("JSIMD_QUERY_WORKERS") ?? 8),
  Math.max(1, navigator.hardwareConcurrency),
);
const GROUP_COUNT = 8;
const WORKLOAD = parseWorkload(Deno.env.get("JSIMD_GROUP_WORKLOAD") ?? "q1");

const filter = new Int32Array(LENGTH);
const values = new Int32Array(LENGTH);
const groups = new Uint8Array(LENGTH);
let state = 0x1234_5678;
for (let index = 0; index < LENGTH; index++) {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  filter[index] = WORKLOAD === "q1" ? state % 50 : index;
  values[index] = ((state >>> 8) % 20_001) - 10_000;
  groups[index] = (state >>> 24) & (GROUP_COUNT - 1);
}
const [lower, upper] = WORKLOAD === "q1"
  ? [0, 25]
  : [Math.floor(LENGTH * 0.7), Math.floor(LENGTH * 0.8)];
const scanStart = WORKLOAD === "q1" ? 0 : Math.floor(lower / PAGE_ROWS) * PAGE_ROWS;
const scanEnd = WORKLOAD === "q1"
  ? LENGTH
  : Math.min(LENGTH, Math.ceil(upper / PAGE_ROWS) * PAGE_ROWS);
const expected = groupByBetweenReference(filter, values, groups, lower, upper, GROUP_COUNT);
validate(
  scanJavaScript(filter, values, groups, lower, upper, GROUP_COUNT, scanStart, scanEnd),
  expected.groups,
);

const jsDurations = measureSync(() => {
  validate(
    scanJavaScript(filter, values, groups, lower, upper, GROUP_COUNT, scanStart, scanEnd),
    expected.groups,
  );
});
const initialized = performance.now();
await using query = await ParallelI32GroupByU8Query.create(
  { filter, values, groups },
  { groupCount: GROUP_COUNT, workerCount: WORKERS, pageRows: PAGE_ROWS },
);
const initializationMs = performance.now() - initialized;
const singleDurations = measureSync(() => {
  validate(query.aggregateBetweenSingleThread(lower, upper).groups, expected.groups);
});
const workerDurations = await measureAsync(async () => {
  validate((await query.aggregateBetween(lower, upper)).groups, expected.groups);
});
const jsMedian = median(jsDurations);
const singleMedian = median(singleDurations);

console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
    workload: {
      shape: WORKLOAD === "q1"
        ? "Q1-like low-cardinality filter/group-by count+sum+min+max"
        : "page-pruned log time-range/group-by count+sum+min+max",
      rows: LENGTH,
      bytes: filter.byteLength + values.byteLength + groups.byteLength,
      pageRows: PAGE_ROWS,
      groupCount: GROUP_COUNT,
      selectivity: expected.groups.reduce((total, group) => total + group.count, 0) / LENGTH,
      warmups: WARMUPS,
      samples: SAMPLES,
    },
    initializationMs: round(initializationMs),
    measurements: [
      summarize("optimized-javascript", 1, jsDurations, jsMedian, singleMedian),
      summarize("single-thread-wasm-simd", 1, singleDurations, jsMedian, singleMedian),
      summarize("shared-memory-workers", WORKERS, workerDurations, jsMedian, singleMedian),
    ],
  },
  null,
  2,
));

function measureSync(operation: () => void): number[] {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    operation();
    const elapsed = performance.now() - started;
    if (sample >= 0) durations.push(elapsed);
  }
  return durations;
}

function scanJavaScript(
  filterColumn: Int32Array,
  valueColumn: Int32Array,
  groupColumn: Uint8Array,
  minimum: number,
  maximum: number,
  groupCount: number,
  scanStart: number,
  scanEnd: number,
): GroupByAggregate[] {
  const counts = new Uint32Array(groupCount);
  const sums = new Float64Array(groupCount);
  const minimums = new Int32Array(groupCount).fill(0x7fff_ffff);
  const maximums = new Int32Array(groupCount).fill(-0x8000_0000);
  for (let index = scanStart; index < scanEnd; index++) {
    const filterValue = filterColumn[index]!;
    if (filterValue < minimum || filterValue >= maximum) continue;
    const group = groupColumn[index]!;
    const value = valueColumn[index]!;
    counts[group]++;
    sums[group] += value;
    if (value < minimums[group]!) minimums[group] = value;
    if (value > maximums[group]!) maximums[group] = value;
  }
  const output: GroupByAggregate[] = [];
  for (let group = 0; group < groupCount; group++) {
    if (counts[group] === 0) continue;
    output.push({
      group,
      count: counts[group]!,
      sum: BigInt(sums[group]!),
      min: minimums[group]!,
      max: maximums[group]!,
    });
  }
  return output;
}

async function measureAsync(operation: () => Promise<void>): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    await operation();
    const elapsed = performance.now() - started;
    if (sample >= 0) durations.push(elapsed);
  }
  return durations;
}

function summarize(
  mode: string,
  workers: number,
  durations: number[],
  jsMedian: number,
  singleMedian: number,
): Record<string, number | string> {
  const medianMs = median(durations);
  return {
    mode,
    workers,
    medianMs: round(medianMs),
    p95Ms: round(percentile(durations, 0.95)),
    speedupVsJs: round(jsMedian / medianMs),
    speedupVsSingleWasm: round(singleMedian / medianMs),
  };
}

function validate(
  actual: readonly GroupByAggregate[],
  expectedGroups: readonly GroupByAggregate[],
): void {
  if (actual.length !== expectedGroups.length) throw new Error("group count mismatch");
  for (let index = 0; index < actual.length; index++) {
    const left = actual[index]!;
    const right = expectedGroups[index]!;
    if (
      left.group !== right.group || left.count !== right.count || left.sum !== right.sum ||
      left.min !== right.min || left.max !== right.max
    ) {
      throw new Error(`aggregate mismatch for group ${right.group}`);
    }
  }
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseWorkload(value: string): "q1" | "logs" {
  if (value === "q1" || value === "logs") return value;
  throw new Error(`JSIMD_GROUP_WORKLOAD must be q1 or logs, got ${value}`);
}
