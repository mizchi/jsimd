import { ParallelI32Query } from "../../packages/olap/src/mod.ts";
import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";

const LENGTH = Number(Deno.env.get("JSIMD_QUERY_ROWS") ?? 8 * 1024 * 1024);
const PAGE_ROWS = 65_536;
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 7);
const requestedWorkers = Deno.env.get("JSIMD_QUERY_WORKERS");
const WORKER_COUNTS = (requestedWorkers === undefined ? [1, 2, 4, 8] : [Number(requestedWorkers)])
  .filter(
    (count) => count <= Math.max(1, navigator.hardwareConcurrency),
  );

const values = new Int32Array(LENGTH);
let state = 0x1234_5678;
for (let index = 0; index < values.length; index++) {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  values[index] = (state & 0xffff) - 0x8000;
}
const minimum = -8_192;
const maximum = 8_192;
let correctnessChecks = 0;
const expected = scanJavaScript(values, minimum, maximum);

const jsDurations = measureSync(() => {
  const result = scanJavaScript(values, minimum, maximum);
  validate(result.count, BigInt(result.sum), expected.count, BigInt(expected.sum));
});
const jsMedian = median(jsDurations);

let singleWasmMedian = 0;
const measurements = [
  summarizeBenchmarkSamples("optimized-javascript/workers=1", "end-to-end", jsDurations),
];
const metrics: Record<string, number | string | boolean> = {
  predicate: `${minimum} <= value < ${maximum}`,
  selectivity: expected.count / LENGTH,
};

for (const workerCount of WORKER_COUNTS) {
  const initialized = performance.now();
  await using query = await ParallelI32Query.create(values, { workerCount, pageRows: PAGE_ROWS });
  const initMs = performance.now() - initialized;
  if (workerCount === 1) {
    const durations = measureSync(() => {
      const result = query.scanBetweenSingleThread(minimum, maximum);
      validate(result.count, result.sum, expected.count, BigInt(expected.sum));
    });
    singleWasmMedian = median(durations);
    measurements.push(summarizeBenchmarkSamples(
      "single-thread-wasm-simd/workers=1",
      "end-to-end",
      durations,
    ));
  }

  const durations = await measureAsync(async () => {
    const result = await query.scanBetween(minimum, maximum);
    validate(result.count, result.sum, expected.count, BigInt(expected.sum));
  });
  measurements.push(summarizeBenchmarkSamples(
    `shared-memory-workers/workers=${workerCount}`,
    "end-to-end",
    durations,
  ));
  metrics[`initializationMsWorkers${workerCount}`] = round(initMs);
  metrics[`speedupVsJsWorkers${workerCount}`] = round(jsMedian / median(durations));
  metrics[`speedupVsSingleWasmWorkers${workerCount}`] = round(
    singleWasmMedian / median(durations),
  );
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/range-count-sum",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      rows: LENGTH,
      pageRows: PAGE_ROWS,
      selectivity: expected.count / LENGTH,
      workerCounts: WORKER_COUNTS,
    },
    bytes: values.byteLength,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "every count and sum matched the optimized JavaScript reference",
  },
  measurements,
  metrics,
  notes: [
    "Each end-to-end boundary is one warm query over caller-resident input; index construction is excluded and recorded separately in metrics.",
    "Worker counts construct and dispose separate query instances sequentially in one process.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_QUERY_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function scanJavaScript(
  input: Int32Array,
  lower: number,
  upper: number,
): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let index = 0; index < input.length; index++) {
    const value = input[index]!;
    if (value >= lower && value < upper) {
      count++;
      sum += value;
    }
  }
  return { count, sum };
}

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

function validate(count: number, sum: bigint, expectedCount: number, expectedSum: bigint): void {
  if (count !== expectedCount || sum !== expectedSum) {
    throw new Error(`aggregate mismatch: count=${count}, sum=${sum}`);
  }
  correctnessChecks++;
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
