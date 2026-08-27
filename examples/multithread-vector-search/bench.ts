import { BlockedVectorArray } from "../../src/blocked-vector-array/mod.ts";
import { MultithreadVectorSearch } from "./search.ts";

const COUNTS = [32_768, 131_072, 262_144, 524_288] as const;
const DIMENSIONS = 128;
const K = 10;
const WORKERS = 4;
const WARMUPS = 3;
const SAMPLES = 20;

const results = [];
for (const count of COUNTS) results.push(await benchmarkCount(count));
console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build, logicalCpus: navigator.hardwareConcurrency },
    dimensions: DIMENSIONS,
    k: K,
    workers: WORKERS,
    samples: SAMPLES,
    results,
  },
  null,
  2,
));

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
    count,
    singleBuildMs: round(singleBuildMs),
    multiBuildMs: round(multiBuildMs),
    singleQueryMedianMs: round(singleMedian),
    multiQueryMedianMs: round(multiMedian),
    querySpeedup: round(singleMedian / multiMedian),
    singleQueryP99Ms: round(percentile(singleSamples, 0.99)),
    multiQueryP99Ms: round(percentile(multiSamples, 0.99)),
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
