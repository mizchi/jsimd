import { ParallelI32Query } from "./mod.ts";

const LENGTH = Number(Deno.env.get("JSIMD_QUERY_ROWS") ?? 8 * 1024 * 1024);
const PAGE_ROWS = 65_536;
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 7);
const requestedWorkers = Deno.env.get("JSIMD_QUERY_WORKERS");
const WORKER_COUNTS = (requestedWorkers === undefined ? [1, 2, 4, 8] : [Number(requestedWorkers)])
  .filter(
    (count) => count <= Math.max(1, navigator.hardwareConcurrency),
  );

interface Measurement {
  readonly mode: string;
  readonly workers: number;
  readonly initMs?: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly speedupVsJs: number;
  readonly speedupVsSingleWasm: number;
}

const values = new Int32Array(LENGTH);
let state = 0x1234_5678;
for (let index = 0; index < values.length; index++) {
  state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  values[index] = (state & 0xffff) - 0x8000;
}
const minimum = -8_192;
const maximum = 8_192;
const expected = scanJavaScript(values, minimum, maximum);

const jsDurations = measureSync(() => {
  const result = scanJavaScript(values, minimum, maximum);
  validate(result.count, BigInt(result.sum), expected.count, BigInt(expected.sum));
});
const jsMedian = median(jsDurations);

let singleWasmMedian = 0;
const measurements: Measurement[] = [{
  mode: "optimized-javascript",
  workers: 1,
  medianMs: round(jsMedian),
  p95Ms: round(percentile(jsDurations, 0.95)),
  speedupVsJs: 1,
  speedupVsSingleWasm: 0,
}];

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
    measurements.push(summarize(
      "single-thread-wasm-simd",
      1,
      initMs,
      durations,
      jsMedian,
      singleWasmMedian,
    ));
  }

  const durations = await measureAsync(async () => {
    const result = await query.scanBetween(minimum, maximum);
    validate(result.count, result.sum, expected.count, BigInt(expected.sum));
  });
  measurements.push(summarize(
    "shared-memory-workers",
    workerCount,
    initMs,
    durations,
    jsMedian,
    singleWasmMedian,
  ));
}

console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
    workload: {
      rows: LENGTH,
      bytes: values.byteLength,
      pageRows: PAGE_ROWS,
      selectivity: expected.count / LENGTH,
      warmups: WARMUPS,
      samples: SAMPLES,
    },
    measurements,
  },
  null,
  2,
));

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

function summarize(
  mode: string,
  workers: number,
  initMs: number,
  durations: number[],
  jsMedian: number,
  wasmMedian: number,
): Measurement {
  const medianMs = median(durations);
  return {
    mode,
    workers,
    initMs: round(initMs),
    medianMs: round(medianMs),
    p95Ms: round(percentile(durations, 0.95)),
    speedupVsJs: round(jsMedian / medianMs),
    speedupVsSingleWasm: round(wasmMedian / medianMs),
  };
}

function validate(count: number, sum: bigint, expectedCount: number, expectedSum: bigint): void {
  if (count !== expectedCount || sum !== expectedSum) {
    throw new Error(`aggregate mismatch: count=${count}, sum=${sum}`);
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
