import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels } from "../../packages/olap/src/kernel.ts";
import {
  type LocalGroupEntryU32,
  LocalGroupHashTableU32,
} from "../../packages/olap/src/local_group_hash_table.ts";
import { LocalGroupHashWorkerPool } from "../../packages/olap/src/local_group_hash_worker_pool.ts";

const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const ROWS = Number(Deno.env.get("JSIMD_LOCAL_GROUP_ROWS") ?? 1 << 20);
const DISTINCT = Number(Deno.env.get("JSIMD_LOCAL_GROUP_DISTINCT") ?? 1 << 12);
const WORKERS = Number(Deno.env.get("JSIMD_LOCAL_GROUP_WORKERS") ?? 4);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const CAPACITY = nextPowerOfTwo(Math.ceil(DISTINCT / 0.75));
const TABLE_STRIDE = LocalGroupHashTableU32.byteLengthFor(CAPACITY);
const TABLE_COUNT = 1 + WORKERS * 2;
const keysOffset = TABLE_STRIDE * TABLE_COUNT;
const valuesOffset = keysOffset + ROWS * 4;
const validitiesOffset = valuesOffset + ROWS * 4;
const requiredBytes = validitiesOffset + ROWS;
const pages = Math.ceil((requiredBytes + 1024) / 65_536);

using shared = await SharedBuffer.create({ initialPages: pages });
const kernels = await instantiateQueryKernels(shared.memory);
const single = LocalGroupHashTableU32.initialize(shared, 0, CAPACITY);
const partials = Array.from(
  { length: WORKERS },
  (_, index) => LocalGroupHashTableU32.initialize(shared, TABLE_STRIDE * (index + 1), CAPACITY),
);
const partitions = Array.from(
  { length: WORKERS },
  (_, index) =>
    LocalGroupHashTableU32.initialize(
      shared,
      TABLE_STRIDE * (WORKERS + index + 1),
      CAPACITY,
    ),
);
const keys = shared.uint32Array(keysOffset, ROWS);
const values = shared.int32Array(valuesOffset, ROWS);
const validities = shared.uint8Array(validitiesOffset, ROWS);
let random = 0x1234_5678;
for (let row = 0; row < ROWS; row++) {
  random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
  keys[row] = Math.imul(row % DISTINCT, 0x9e37_79b1) >>> 0;
  values[row] = ((random >>> 8) & 0xffff) - 0x8000;
  validities[row] = row % 17 === 0 ? 0 : 1;
}

const expected = aggregateJavaScript(keys, values, validities);
single.aggregateResident(keysOffset, valuesOffset, validitiesOffset, ROWS, kernels);
validateEntries(single.entries(), expected);
single.clear();
aggregateRadixTables();
validateEntries(partitions.flatMap((table) => table.entries()), expected);

let sink = 0;
const jsDurations = measure(() => {
  sink ^= checksumMap(aggregateJavaScript(keys, values, validities));
});
const singleDurations = measure(() => {
  single.clear();
  single.aggregateResident(keysOffset, valuesOffset, validitiesOffset, ROWS, kernels);
  sink ^= checksumEntries(single.entries());
});
const radixDurations = measure(() => {
  aggregateRadixTables();
  for (const table of partitions) sink ^= checksumEntries(table.entries());
});
await using workerPool = await LocalGroupHashWorkerPool.create(shared, partials, partitions, {
  keysByteOffset: keysOffset,
  valuesByteOffset: valuesOffset,
  validitiesByteOffset: validitiesOffset,
  rowCount: ROWS,
});
await workerPool.aggregate();
validateEntries(partitions.flatMap((table) => table.entries()), expected);
const workerDurations = await measureAsync(async () => {
  await workerPool.aggregate();
  for (const table of partitions) sink ^= checksumEntries(table.entries());
});

const jsMedian = median(jsDurations);
const singleMedian = median(singleDurations);
const radixMedian = median(radixDurations);
const workerMedian = median(workerDurations);
const result = createBenchmarkResult({
  name: "parallel-columnar-query/local-group-hash-u32",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: { rows: ROWS, distinctKeys: DISTINCT, capacity: CAPACITY, partitions: WORKERS },
    bytes: keys.byteLength + values.byteLength + validities.byteLength,
  },
  correctness: {
    passed: true,
    checks: 2,
    summary: "every key and nullable count/sum/min/max state matched JavaScript Map",
  },
  measurements: [
    summarizeBenchmarkSamples("javascript-map", "materialization-inclusive", jsDurations),
    summarizeBenchmarkSamples(
      "single-wasm-swiss-table",
      "materialization-inclusive",
      singleDurations,
    ),
    summarizeBenchmarkSamples(
      `worker-local-radix-merge/partitions=${WORKERS}`,
      "materialization-inclusive",
      radixDurations,
    ),
    summarizeBenchmarkSamples(
      `persistent-workers-radix-owner-merge/workers=${WORKERS}`,
      "materialization-inclusive",
      workerDurations,
    ),
  ],
  metrics: {
    speedupSingleWasmVsJs: round(jsMedian / singleMedian),
    speedupSequentialRadixVsJs: round(jsMedian / radixMedian),
    sequentialRadixOverheadVsSingle: round(radixMedian / singleMedian),
    speedupWorkersVsJs: round(jsMedian / workerMedian),
    speedupWorkersVsSingle: round(singleMedian / workerMedian),
    sink,
  },
  notes: [
    "Inputs and Wasm tables are resident in one SharedBuffer; JavaScript reads the same typed arrays.",
    "The radix result measures the data structure and owner-merge ABI sequentially; it is not a Worker speedup result.",
    "The persistent-Worker result runs one local build and one owned output partition per Worker; construction is excluded.",
    "Every measurement includes clearing prior state and materializing all aggregate entries.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_LOCAL_GROUP_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function aggregateRadixTables(): void {
  const shardRows = Math.ceil(ROWS / WORKERS);
  partials.forEach((table, worker) => {
    table.clear();
    const start = worker * shardRows;
    const length = Math.min(shardRows, ROWS - start);
    if (length <= 0) return;
    table.aggregateResident(
      keysOffset + start * 4,
      valuesOffset + start * 4,
      validitiesOffset + start,
      length,
      kernels,
    );
  });
  partitions.forEach((output, partition) => {
    output.clear();
    for (const partial of partials) {
      output.mergePartitionFrom(partial, partition, WORKERS, kernels);
    }
  });
}

interface MutableAggregate {
  count: number;
  nullCount: number;
  sum: number;
  min: number;
  max: number;
}

function aggregateJavaScript(
  inputKeys: Uint32Array,
  inputValues: Int32Array,
  inputValidities: Uint8Array,
): Map<number, MutableAggregate> {
  const output = new Map<number, MutableAggregate>();
  for (let row = 0; row < inputKeys.length; row++) {
    const key = inputKeys[row]!;
    let state = output.get(key);
    if (state === undefined) {
      state = { count: 0, nullCount: 0, sum: 0, min: I32_MAX, max: I32_MIN };
      output.set(key, state);
    }
    if (inputValidities[row] === 0) {
      state.nullCount++;
      continue;
    }
    const value = inputValues[row]!;
    state.count++;
    state.sum += value;
    if (value < state.min) state.min = value;
    if (value > state.max) state.max = value;
  }
  return output;
}

function validateEntries(
  entries: readonly LocalGroupEntryU32[],
  expected: ReadonlyMap<number, MutableAggregate>,
): void {
  if (entries.length !== expected.size) throw new Error("distinct group count mismatch");
  for (const entry of entries) {
    const state = expected.get(entry.key);
    if (
      state === undefined || entry.count !== state.count || entry.nullCount !== state.nullCount ||
      entry.sum !== BigInt(state.sum) || entry.min !== (state.count === 0 ? null : state.min) ||
      entry.max !== (state.count === 0 ? null : state.max)
    ) throw new Error(`aggregate mismatch for key ${entry.key}`);
  }
}

function checksumMap(map: ReadonlyMap<number, MutableAggregate>): number {
  let checksum = 0;
  for (const [key, state] of map) {
    checksum =
      (checksum + key + state.count + state.nullCount + state.sum + state.min + state.max) |
      0;
  }
  return checksum;
}

function checksumEntries(entries: readonly LocalGroupEntryU32[]): number {
  let checksum = 0;
  for (const entry of entries) {
    checksum = (checksum + entry.key + entry.count + entry.nullCount + Number(entry.sum) +
      (entry.min ?? 0) + (entry.max ?? 0)) | 0;
  }
  return checksum;
}

function measure(operation: () => void): number[] {
  const samples: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    operation();
    const elapsed = performance.now() - started;
    if (sample >= 0) samples.push(elapsed);
  }
  return samples;
}

async function measureAsync(operation: () => Promise<void>): Promise<number[]> {
  const samples: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    await operation();
    const elapsed = performance.now() - started;
    if (sample >= 0) samples.push(elapsed);
  }
  return samples;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function nextPowerOfTwo(value: number): number {
  let output = 1;
  while (output < value) output *= 2;
  return output;
}
