import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { RoaringBitmap } from "@mizchi/jsimd/roaring-bitmap";
import { StripedRoaringIntersectionBatch } from "./batch.ts";

const CONTAINERS = Number(Deno.env.get("JSIMD_STRIPED_ROARING_CONTAINERS") ?? 16);
const PAIR_COUNTS = [1, 16, 64] as const;
const MAX_PAIRS = PAIR_COUNTS.at(-1)!;
const WORKERS = Number(Deno.env.get("JSIMD_STRIPED_ROARING_WORKERS") ?? 4);
const WARMUPS = Number(Deno.env.get("JSIMD_STRIPED_ROARING_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_STRIPED_ROARING_SAMPLES") ?? 11);
const OPERATIONS = Number(Deno.env.get("JSIMD_STRIPED_ROARING_OPERATIONS") ?? 5);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };

const leftValues = denseValues(CONTAINERS, 7);
const rightValues = denseValues(CONTAINERS, 11);
const sourcePairs = Array.from(
  { length: MAX_PAIRS },
  () => ({ left: leftValues, right: rightValues }),
);
const serialPairs = sourcePairs.map((pair) => ({
  left: RoaringBitmap.from(pair.left),
  right: RoaringBitmap.from(pair.right),
}));
const batches: StripedRoaringIntersectionBatch[] = [];
try {
  for (const pairCount of PAIR_COUNTS) {
    batches.push(
      await StripedRoaringIntersectionBatch.create(sourcePairs.slice(0, pairCount), {
        workerCount: Math.min(WORKERS, pairCount),
      }),
    );
  }

  const measurements = [];
  const metrics: Record<string, number> = {};
  const workerOutput = new Float64Array(MAX_PAIRS);
  let correctnessChecks = 0;
  let sink = 0;
  const expected = serialPairs[0]!.left.andCardinality(serialPairs[0]!.right);

  for (let caseIndex = 0; caseIndex < PAIR_COUNTS.length; caseIndex++) {
    const pairCount = PAIR_COUNTS[caseIndex]!;
    const batch = batches[caseIndex]!;
    const serial = await measureResident(`serial-roaring/${pairCount}-pairs`, timing, () => {
      for (let index = 0; index < pairCount; index++) {
        const pair = serialPairs[index]!;
        sink ^= pair.left.andCardinality(pair.right);
      }
    });
    const striped = await measureResident(
      `striped-workers/${pairCount}-pairs`,
      timing,
      async () => {
        await batch.intersectionCardinalitiesInto(workerOutput);
        sink ^= workerOutput[pairCount - 1]!;
      },
    );
    measurements.push(serial, striped);
    metrics[`speedup_${pairCount}_pairs`] = round(serial.medianMs / striped.medianMs);
    await batch.intersectionCardinalitiesInto(workerOutput);
    for (let index = 0; index < pairCount; index++) {
      if (workerOutput[index] !== expected) throw new Error(`intersection mismatch at ${index}`);
      correctnessChecks++;
    }
  }

  const sortedOutput = new Float64Array(MAX_PAIRS);
  const sorted = await measureResident(`sorted-u32/${MAX_PAIRS}-pairs`, timing, () => {
    for (let index = 0; index < MAX_PAIRS; index++) {
      sortedOutput[index] = sortedIntersectionCount(leftValues, rightValues);
      sink ^= sortedOutput[index]!;
    }
  });
  measurements.push(sorted);
  metrics[`speedup_vs_sorted_${MAX_PAIRS}_pairs`] = round(
    sorted.medianMs / measurements[measurements.length - 2]!.medianMs,
  );

  const result = createBenchmarkResult({
    name: "striped-roaring-bitmap/resident-intersection-batch",
    recordedAt: new Date().toISOString(),
    environment: detectBenchmarkEnvironment({
      logicalCpus: navigator.hardwareConcurrency,
      cpu: await detectHostCpu(),
      adapter: null,
    }),
    timing,
    input: {
      shape: {
        containersPerSet: CONTAINERS,
        valuesLeft: leftValues.length,
        valuesRight: rightValues.length,
        pairCounts: PAIR_COUNTS,
        workers: WORKERS,
      },
      bytes: (leftValues.byteLength + rightValues.byteLength) * MAX_PAIRS,
    },
    correctness: {
      passed: true,
      checks: correctnessChecks,
      summary: "Worker-resident Roaring intersections match serial Roaring cardinalities",
    },
    measurements,
    metrics: { ...metrics, intersectionCardinality: expected, sink: sink >>> 0 },
    notes: [
      "All Roaring containers and Workers are resident; construction and Worker startup are excluded.",
      "Each operation includes Worker dispatch and returning one exact number cardinality per pair.",
      "The serial baseline uses the same resident Roaring implementation; the sorted baseline scans both complete typed arrays.",
      "Pairs are independent posting-list intersections assigned round-robin to persistent Workers.",
    ],
  });
  const json = JSON.stringify(result, null, 2) + "\n";
  const output = Deno.env.get("JSIMD_STRIPED_ROARING_OUTPUT");
  if (output !== undefined) await Deno.writeTextFile(output, json);
  console.log(json);
} finally {
  await Promise.all(batches.map((batch) => batch[Symbol.asyncDispose]()));
  for (const pair of serialPairs) {
    pair.right[Symbol.dispose]();
    pair.left[Symbol.dispose]();
  }
}

function denseValues(containerCount: number, divisor: number): Uint32Array {
  const output = new Uint32Array(containerCount * Math.ceil(65_536 / divisor));
  let index = 0;
  for (let high = 0; high < containerCount; high++) {
    const base = high * 65_536;
    for (let low = 0; low < 65_536; low += divisor) output[index++] = base + low;
  }
  return output.subarray(0, index);
}

function sortedIntersectionCount(left: Uint32Array, right: Uint32Array): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a < b) leftIndex++;
    else if (a > b) rightIndex++;
    else {
      count++;
      leftIndex++;
      rightIndex++;
    }
  }
  return count;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
