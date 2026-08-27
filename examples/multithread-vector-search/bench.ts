import { BlockedVectorArray } from "../../src/blocked-vector-array/mod.ts";
import { MultithreadVectorSearch } from "./search.ts";
import {
  type BenchmarkMeasurement,
  summarizeBenchmarkSamples,
} from "../../tools/benchmark/measure.ts";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "../../tools/benchmark/result.ts";

const COUNTS = [32_768, 131_072, 262_144, 524_288] as const;
const DIMENSIONS = 128;
const K = 10;
const WORKERS = 4;
const WARMUPS = 3;
const SAMPLES = 20;

const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number | string | boolean> = {};
for (const count of COUNTS) {
  const result = await benchmarkCount(count);
  measurements.push(...result.measurements);
  metrics[`count=${count}/singleBuildMs`] = result.singleBuildMs;
  metrics[`count=${count}/multiBuildMs`] = result.multiBuildMs;
  metrics[`count=${count}/querySpeedup`] = result.querySpeedup;
}
const report = createBenchmarkResult({
  name: "examples/multithread-vector-search",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      counts: [...COUNTS],
      dimensions: DIMENSIONS,
      k: K,
      workers: WORKERS,
    },
    bytes: Math.max(...COUNTS) * DIMENSIONS * Float32Array.BYTES_PER_ELEMENT,
  },
  correctness: {
    passed: true,
    checks: COUNTS.length * (WARMUPS + SAMPLES),
    summary: "Single-thread and multi-Worker search returned the query row as nearest neighbor.",
  },
  measurements,
  metrics,
  notes: [
    "Resident query measurements exclude index construction and include Worker messaging for the multi-Worker path.",
    "Construction timings are one-shot metrics and do not have sample distributions.",
  ],
});
const json = `${JSON.stringify(report, null, 2)}\n`;
const output = Deno.env.get("JSIMD_EXAMPLE_VECTOR_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

async function benchmarkCount(count: number) {
  const values = deterministicVectors(count, DIMENSIONS);
  const singleBuildStarted = performance.now();
  using single = BlockedVectorArray.from(values, count, DIMENSIONS);
  const singleBuildMs = performance.now() - singleBuildStarted;
  const multiBuildStarted = performance.now();
  await using multi = await MultithreadVectorSearch.create(values, count, DIMENSIONS, {
    workerCount: WORKERS,
    k: K,
  });
  const multiBuildMs = performance.now() - multiBuildStarted;
  const singleIds = new Uint32Array(K);
  const singleDistances = new Float32Array(K);
  const singleSamples: number[] = [];
  const multiSamples: number[] = [];

  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const row = (sample + WARMUPS) * 977 % count;
    const query = values.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS);
    let started = performance.now();
    single.topKInto(query, singleIds, singleDistances);
    const singleElapsed = performance.now() - started;
    started = performance.now();
    const result = await multi.search(query);
    const multiElapsed = performance.now() - started;
    if (singleIds[0] !== row || result.ids[0] !== row) {
      throw new Error("nearest-neighbor mismatch");
    }
    if (sample >= 0) {
      singleSamples.push(singleElapsed);
      multiSamples.push(multiElapsed);
    }
  }

  const singleMedian = median(singleSamples);
  const multiMedian = median(multiSamples);
  return {
    measurements: [
      summarizeBenchmarkSamples(`count=${count}/single-thread-query`, "resident", singleSamples),
      summarizeBenchmarkSamples(`count=${count}/four-worker-query`, "resident", multiSamples),
    ],
    singleBuildMs: round(singleBuildMs),
    multiBuildMs: round(multiBuildMs),
    querySpeedup: round(singleMedian / multiMedian),
  };
}

function deterministicVectors(count: number, dimensions: number): Float32Array {
  const output = new Float32Array(count * dimensions);
  let state = 0x1234_5678;
  for (let index = 0; index < output.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = ((state >>> 8) / 0x100_0000) * 2 - 1;
  }
  return output;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
