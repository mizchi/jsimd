import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { summarizeBenchmarkSamples } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels } from "../../packages/olap/src/kernel.ts";
import { PartitionedHashJoinTableU32 } from "../../packages/olap/src/partitioned_hash_join.ts";
import { PartitionedHashJoinWorkerPool } from "../../packages/olap/src/partitioned_hash_join_worker_pool.ts";

const BUILD_ROWS = Number(Deno.env.get("JSIMD_JOIN_BUILD_ROWS") ?? 1 << 17);
const DISTINCT_KEYS = Number(Deno.env.get("JSIMD_JOIN_DISTINCT") ?? 1 << 16);
const PROBE_ROWS = Number(Deno.env.get("JSIMD_JOIN_PROBE_ROWS") ?? 1 << 20);
const DUPLICATES = BUILD_ROWS / DISTINCT_KEYS;
const PARTITIONS = 4;
const WORKERS = 4;
const CAPACITY_PER_PARTITION = nextPowerOfTwo(
  Math.ceil(DISTINCT_KEYS / PARTITIONS / 0.75),
);
const WARMUPS = Number(Deno.env.get("JSIMD_QUERY_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_QUERY_SAMPLES") ?? 11);
const ratios = [0.1, 0.5, 0.9] as const;

if (!Number.isInteger(DUPLICATES) || DUPLICATES <= 0) {
  throw new Error("build rows must be a positive multiple of distinct keys");
}
const common = {
  partitionCount: PARTITIONS,
  capacityPerPartition: CAPACITY_PER_PARTITION,
  maxBuildRows: BUILD_ROWS,
};
const noBloomBytes = PartitionedHashJoinTableU32.byteLengthFor(common);
const bloomOffset = noBloomBytes;
const bloomBytes = PartitionedHashJoinTableU32.byteLengthFor({ ...common, bloomBitsPerKey: 10 });
const buildKeysOffset = bloomOffset + bloomBytes;
const buildRowIdsOffset = buildKeysOffset + BUILD_ROWS * 4;
const probeKeysOffset = buildRowIdsOffset + BUILD_ROWS * 4;
const probeRowIdsOffset = probeKeysOffset + PROBE_ROWS * 4;
const outputCapacity = PROBE_ROWS * DUPLICATES;
const outputProbeOffset = probeRowIdsOffset + PROBE_ROWS * 4;
const outputBuildOffset = outputProbeOffset + outputCapacity * 4;
const requiredBytes = outputBuildOffset + outputCapacity * 4;
const pages = Math.ceil((requiredBytes + 65_535) / 65_536);

using shared = await SharedBuffer.create({
  initialPages: pages,
  maximumPages: pages,
  maxWorkers: WORKERS * 2 + 1,
});
const kernels = await instantiateQueryKernels(shared.memory);
const noBloom = PartitionedHashJoinTableU32.initialize(shared, 0, common);
const bloom = PartitionedHashJoinTableU32.initialize(shared, bloomOffset, {
  ...common,
  bloomBitsPerKey: 10,
});
const buildKeys = shared.uint32Array(buildKeysOffset, BUILD_ROWS);
const buildRows = shared.uint32Array(buildRowIdsOffset, BUILD_ROWS);
const probeKeys = shared.uint32Array(probeKeysOffset, PROBE_ROWS);
const probeRows = shared.uint32Array(probeRowIdsOffset, PROBE_ROWS);
const outputProbe = shared.uint32Array(outputProbeOffset, outputCapacity);
const outputBuild = shared.uint32Array(outputBuildOffset, outputCapacity);
for (let row = 0; row < BUILD_ROWS; row++) {
  buildKeys[row] = joinKey(row % DISTINCT_KEYS);
  buildRows[row] = row;
}
for (let row = 0; row < PROBE_ROWS; row++) probeRows[row] = row;

const jsBuildStart = performance.now();
const jsTable = buildJavaScript(buildKeys, buildRows);
const jsBuildMs = performance.now() - jsBuildStart;
const noBloomBuildStart = performance.now();
noBloom.buildResident(buildKeysOffset, buildRowIdsOffset, BUILD_ROWS, kernels);
const noBloomBuildMs = performance.now() - noBloomBuildStart;
const bloomBuildStart = performance.now();
bloom.buildResident(buildKeysOffset, buildRowIdsOffset, BUILD_ROWS, kernels);
const bloomBuildMs = performance.now() - bloomBuildStart;
const workerOutputCapacity = Math.ceil(PROBE_ROWS / WORKERS) * DUPLICATES;
const workerOutputs = Array.from({ length: WORKERS }, (_, worker) => ({
  probeRowIdsByteOffset: outputProbeOffset + worker * workerOutputCapacity * 4,
  buildRowIdsByteOffset: outputBuildOffset + worker * workerOutputCapacity * 4,
  capacity: workerOutputCapacity,
}));
const probeInput = {
  keysByteOffset: probeKeysOffset,
  rowIdsByteOffset: probeRowIdsOffset,
  rowCount: PROBE_ROWS,
};
await using noBloomWorkers = await PartitionedHashJoinWorkerPool.create(
  shared,
  noBloom,
  probeInput,
  workerOutputs,
);
await using bloomWorkers = await PartitionedHashJoinWorkerPool.create(
  shared,
  bloom,
  probeInput,
  workerOutputs,
);

const measurements = [];
const bloomRejectRates: Record<string, number> = {};
let sink = 0;
for (const hitRatio of ratios) {
  let expectedMatches = 0;
  for (let row = 0; row < PROBE_ROWS; row++) {
    const hit = row % 10 < hitRatio * 10;
    probeKeys[row] = joinKey(hit ? row % DISTINCT_KEYS : DISTINCT_KEYS + row % DISTINCT_KEYS);
    if (hit) expectedMatches += DUPLICATES;
  }
  const jsResult = probeJavaScript(jsTable, probeKeys, probeRows, outputProbe, outputBuild);
  validateMatchCount(jsResult, expectedMatches, "JavaScript");
  const noBloomResult = noBloom.probeResident(
    probeKeysOffset,
    probeRowIdsOffset,
    PROBE_ROWS,
    outputProbeOffset,
    outputBuildOffset,
    outputCapacity,
    kernels,
  );
  validateMatchCount(noBloomResult.matchCount, expectedMatches, "Wasm hash");
  const bloomResult = bloom.probeResident(
    probeKeysOffset,
    probeRowIdsOffset,
    PROBE_ROWS,
    outputProbeOffset,
    outputBuildOffset,
    outputCapacity,
    kernels,
  );
  validateMatchCount(bloomResult.matchCount, expectedMatches, "Wasm Bloom");
  const count = bloom.countMatchesResident(probeKeysOffset, PROBE_ROWS, kernels);
  validateMatchCount(count.matchCount, expectedMatches, "Wasm count");
  bloomRejectRates[`bloomRejectedPercent_hit${hitRatio * 100}`] = round(
    count.bloomRejected / PROBE_ROWS * 100,
  );
  validateMatchCount((await noBloomWorkers.probe()).matchCount, expectedMatches, "Worker hash");
  validateMatchCount((await bloomWorkers.probe()).matchCount, expectedMatches, "Worker Bloom");

  const jsDurations = measure(() => {
    sink ^= probeJavaScript(jsTable, probeKeys, probeRows, outputProbe, outputBuild);
  });
  const noBloomDurations = measure(() => {
    sink ^= noBloom.probeResident(
      probeKeysOffset,
      probeRowIdsOffset,
      PROBE_ROWS,
      outputProbeOffset,
      outputBuildOffset,
      outputCapacity,
      kernels,
    ).written;
  });
  const bloomDurations = measure(() => {
    sink ^= bloom.probeResident(
      probeKeysOffset,
      probeRowIdsOffset,
      PROBE_ROWS,
      outputProbeOffset,
      outputBuildOffset,
      outputCapacity,
      kernels,
    ).written;
  });
  const noBloomWorkerDurations = await measureAsync(async () => {
    sink ^= (await noBloomWorkers.probe()).written;
  });
  const bloomWorkerDurations = await measureAsync(async () => {
    sink ^= (await bloomWorkers.probe()).written;
  });
  const label = `${Math.round(hitRatio * 100)}%-hits`;
  measurements.push(
    summarizeBenchmarkSamples(
      `javascript-map/${label}`,
      "materialization-inclusive",
      jsDurations,
    ),
    summarizeBenchmarkSamples(
      `wasm-partitioned-hash/${label}`,
      "materialization-inclusive",
      noBloomDurations,
    ),
    summarizeBenchmarkSamples(
      `wasm-partitioned-hash+bloom/${label}`,
      "materialization-inclusive",
      bloomDurations,
    ),
    summarizeBenchmarkSamples(
      `persistent-workers-hash/${label}`,
      "materialization-inclusive",
      noBloomWorkerDurations,
    ),
    summarizeBenchmarkSamples(
      `persistent-workers-hash+bloom/${label}`,
      "materialization-inclusive",
      bloomWorkerDurations,
    ),
  );
  sink ^= outputProbe[expectedMatches - 1] ?? 0;
  sink ^= outputBuild[expectedMatches - 1] ?? 0;
}

const result = createBenchmarkResult({
  name: "parallel-columnar-query/partitioned-hash-join-u32",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      buildRows: BUILD_ROWS,
      distinctBuildKeys: DISTINCT_KEYS,
      duplicatesPerKey: DUPLICATES,
      probeRows: PROBE_ROWS,
      partitions: PARTITIONS,
      capacityPerPartition: CAPACITY_PER_PARTITION,
      hitRatios: ratios.join(","),
    },
    bytes: buildKeys.byteLength + buildRows.byteLength + probeKeys.byteLength +
      probeRows.byteLength,
  },
  correctness: {
    passed: true,
    checks: ratios.length * 6,
    summary: "all exact duplicate row-ID pair counts matched JavaScript Map",
  },
  measurements,
  metrics: {
    jsBuildMs: round(jsBuildMs),
    wasmBuildMs: round(noBloomBuildMs),
    wasmBloomBuildMs: round(bloomBuildMs),
    ...bloomRejectRates,
    sink,
  },
  notes: [
    "Build structures and input columns are resident before timing; build latency is reported separately.",
    "Every probe writes caller-owned probe/build row-ID pairs in stable probe-major and build-input order.",
    "The Bloom path uses one 128-bit block per query and always performs exact hash verification for candidates.",
    "Persistent Workers read the immutable table concurrently and write disjoint caller-owned output shards.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_JOIN_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);

function joinKey(value: number): number {
  return Math.imul(value, 0x9e37_79b1) >>> 0;
}

function buildJavaScript(keys: Uint32Array, rows: Uint32Array): Map<number, number[]> {
  const table = new Map<number, number[]>();
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const chain = table.get(key);
    if (chain === undefined) table.set(key, [rows[index]!]);
    else chain.push(rows[index]!);
  }
  return table;
}

function probeJavaScript(
  table: ReadonlyMap<number, readonly number[]>,
  keys: Uint32Array,
  rows: Uint32Array,
  outputProbeRows: Uint32Array,
  outputBuildRows: Uint32Array,
): number {
  let written = 0;
  for (let index = 0; index < keys.length; index++) {
    const chain = table.get(keys[index]!);
    if (chain === undefined) continue;
    for (const buildRow of chain) {
      outputProbeRows[written] = rows[index]!;
      outputBuildRows[written] = buildRow;
      written++;
    }
  }
  return written;
}

function validateMatchCount(actual: number, expected: number, name: string): void {
  if (actual !== expected) throw new Error(`${name} produced ${actual}, expected ${expected}`);
}

function measure(operation: () => void): number[] {
  for (let index = 0; index < WARMUPS; index++) operation();
  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const start = performance.now();
    operation();
    durations.push(performance.now() - start);
  }
  return durations;
}

async function measureAsync(operation: () => Promise<void>): Promise<number[]> {
  for (let index = 0; index < WARMUPS; index++) await operation();
  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const start = performance.now();
    await operation();
    durations.push(performance.now() - start);
  }
  return durations;
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
