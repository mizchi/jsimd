import { BlockedBloomFilterU32 } from "@mizchi/jsimd/blocked-bloom-filter";
import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { ParallelBlockedBloomFilterU32 } from "./pipeline.ts";

const BUILD_KEYS = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_BUILD_KEYS") ?? 1 << 20);
const QUERY_KEYS = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_QUERY_KEYS") ?? 1 << 20);
const WORKERS = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_WORKERS") ?? 4);
const WARMUPS = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_SAMPLES") ?? 11);
const OPERATIONS = Number(Deno.env.get("JSIMD_PARALLEL_BLOOM_OPERATIONS") ?? 2);
const BITS_PER_KEY = 10;
const hitRatios = [0.1, 0.5, 0.9] as const;
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };

const buildKeys = Uint32Array.from({ length: BUILD_KEYS }, (_, index) => joinKey(index));
const exact = new Set(buildKeys);
const queries = new Uint32Array(QUERY_KEYS);
const serialOutput = new Uint8Array(QUERY_KEYS);
const parallelOutput = new Uint8Array(QUERY_KEYS);
using serial = new BlockedBloomFilterU32(BUILD_KEYS, BITS_PER_KEY);
await using parallel = await ParallelBlockedBloomFilterU32.create({
  maxBuildKeys: BUILD_KEYS,
  maxQueryKeys: QUERY_KEYS,
  workerCount: WORKERS,
  targetBitsPerKey: BITS_PER_KEY,
});
serial.addMany(buildKeys);
await parallel.replace(buildKeys);

const measurements = [];
const metrics: Record<string, number> = {};
let correctnessChecks = 0;
let sink = 0;

measurements.push(
  await measureResident("serial-rebuild", timing, () => {
    serial.clear().addMany(buildKeys);
  }),
  await measureResident("worker-local-rebuild+simd-or", timing, async () => {
    sink ^= await parallel.replace(buildKeys);
  }),
);
metrics.rebuild_speedup = round(
  measurements[0]!.medianMs / measurements[1]!.medianMs,
);

for (const hitRatio of hitRatios) {
  let expectedHits = 0;
  for (let index = 0; index < QUERY_KEYS; index++) {
    const hit = index % 10 < hitRatio * 10;
    queries[index] = joinKey(hit ? index % BUILD_KEYS : BUILD_KEYS + index);
    if (hit) expectedHits++;
  }

  const serialCandidates = serial.mayContainMany(queries, serialOutput);
  const parallelCandidates = parallel.mayContainMany(queries, parallelOutput);
  assertEqualBytes(serialOutput, parallelOutput);
  const serialExact = verifyCandidates(exact, queries, serialOutput);
  const parallelExact = verifyCandidates(exact, queries, parallelOutput);
  if (serialExact !== expectedHits || parallelExact !== expectedHits) {
    throw new Error(`exact hit mismatch at ratio ${hitRatio}`);
  }
  correctnessChecks += 3;
  const label = `${Math.round(hitRatio * 100)}%-hits`;
  metrics[`candidate_percent_${label}`] = round(serialCandidates / QUERY_KEYS * 100);
  if (serialCandidates !== parallelCandidates) throw new Error("candidate count mismatch");

  const direct = await measureResident(`direct-set/${label}`, timing, () => {
    sink ^= verifyDirect(exact, queries);
  });
  const serialProbe = await measureResident(`serial-bloom+set/${label}`, timing, () => {
    serial.mayContainMany(queries, serialOutput);
    sink ^= verifyCandidates(exact, queries, serialOutput);
  });
  const parallelProbe = await measureResident(`merged-bloom+set/${label}`, timing, () => {
    parallel.mayContainMany(queries, parallelOutput);
    sink ^= verifyCandidates(exact, queries, parallelOutput);
  });
  const serialRefreshProbe = await measureResident(
    `serial-refresh+bloom+set/${label}`,
    timing,
    () => {
      serial.clear().addMany(buildKeys);
      serial.mayContainMany(queries, serialOutput);
      sink ^= verifyCandidates(exact, queries, serialOutput);
    },
  );
  const parallelRefreshProbe = await measureResident(
    `worker-refresh+bloom+set/${label}`,
    timing,
    async () => {
      await parallel.replace(buildKeys);
      parallel.mayContainMany(queries, parallelOutput);
      sink ^= verifyCandidates(exact, queries, parallelOutput);
    },
  );
  measurements.push(
    direct,
    serialProbe,
    parallelProbe,
    serialRefreshProbe,
    parallelRefreshProbe,
  );
  metrics[`probe_vs_direct_${label}`] = round(direct.medianMs / parallelProbe.medianMs);
  metrics[`refresh_speedup_${label}`] = round(
    serialRefreshProbe.medianMs / parallelRefreshProbe.medianMs,
  );
}

const result = createBenchmarkResult({
  name: "parallel-bloom-filter/worker-local-build",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: {
      buildKeys: BUILD_KEYS,
      queryKeys: QUERY_KEYS,
      workers: WORKERS,
      bitsPerKey: BITS_PER_KEY,
      hitRatios: hitRatios.join(","),
    },
    bytes: buildKeys.byteLength + queries.byteLength,
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "merged Worker shards match serial Bloom candidates with no exact false negatives",
  },
  measurements,
  metrics: { ...metrics, sink },
  notes: [
    "Both Bloom implementations reuse allocated storage; Worker startup and exact Set construction are excluded.",
    "Rebuild timing includes input copy, four Worker-local non-atomic builds, dispatch, and SIMD OR reduction.",
    "Probe timing includes input/output copies plus exact Set verification for every Bloom candidate.",
    "Refresh+probe includes Bloom rebuilding but not rebuilding the independently resident exact Set.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_PARALLEL_BLOOM_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);
if (sink === 0x7fff_ffff) console.error("unreachable sink", sink);

function joinKey(value: number): number {
  return Math.imul(value, 0x9e37_79b1) >>> 0;
}

function verifyDirect(exact: ReadonlySet<number>, values: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    if (exact.has(values[index]!)) count++;
  }
  return count;
}

function verifyCandidates(
  exact: ReadonlySet<number>,
  values: Uint32Array,
  candidates: Uint8Array,
): number {
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    if (candidates[index] !== 0 && exact.has(values[index]!)) count++;
  }
  return count;
}

function assertEqualBytes(left: Uint8Array, right: Uint8Array): void {
  if (left.length !== right.length) throw new Error("candidate output length mismatch");
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) throw new Error(`candidate mismatch at ${index}`);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
