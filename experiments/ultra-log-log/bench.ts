import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { ParallelUltraLogLogU32 } from "./parallel.ts";
import { estimateUltraLogLog, JsUltraLogLog, mergeStates } from "./reference.ts";
import { UltraLogLogWorkspace } from "./workspace.ts";

const PRECISION = Number(Deno.env.get("JSIMD_ULL_PRECISION") ?? 14);
const ROWS = Number(Deno.env.get("JSIMD_ULL_ROWS") ?? 1_048_576);
const DISTINCT = Number(Deno.env.get("JSIMD_ULL_DISTINCT") ?? 786_432);
const SHARDS = Number(Deno.env.get("JSIMD_ULL_SHARDS") ?? 8);
const WARMUPS = Number(Deno.env.get("JSIMD_ULL_WARMUPS") ?? 5);
const SAMPLES = Number(Deno.env.get("JSIMD_ULL_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_ULL_OPERATIONS") ?? 1);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };

if (ROWS < DISTINCT || ROWS % SHARDS !== 0) {
  throw new RangeError("rows must cover distinct values and divide evenly into shards");
}

const values = Uint32Array.from(
  { length: ROWS },
  (_, index) => mix32(index % DISTINCT),
);
const registerCount = 1 << PRECISION;
const shardStates = Array.from({ length: SHARDS }, () => new Uint8Array(registerCount));
const mergedJavaScript = new Uint8Array(registerCount);
const mergedWasm = new Uint8Array(registerCount);
let sink = 0;

using javascript = new JsUltraLogLog(PRECISION);
await using workspace = await UltraLogLogWorkspace.create({
  precision: PRECISION,
  maxValues: ROWS,
  shardCapacity: SHARDS,
});
await using parallel = await ParallelUltraLogLogU32.create({
  precision: PRECISION,
  maxValues: ROWS,
  workerCount: SHARDS,
});

javascript.addU32Many(values);
workspace.buildShard(0, values);
const wasmState = new Uint8Array(registerCount);
workspace.shardStateInto(0, wasmState);
assertEqual(wasmState, javascript.state);
const estimate = javascript.estimate();
const relativeError = Math.abs(estimate - DISTINCT) / DISTINCT;

const shardRows = ROWS / SHARDS;
for (let shard = 0; shard < SHARDS; shard++) {
  const input = values.subarray(shard * shardRows, (shard + 1) * shardRows);
  workspace.buildShard(shard, input);
  workspace.shardStateInto(shard, shardStates[shard]!);
}
mergeJavaScriptStates(shardStates, mergedJavaScript);
workspace.mergeInto(SHARDS, mergedWasm);
assertEqual(mergedWasm, mergedJavaScript);
const parallelState = new Uint8Array(registerCount);
await parallel.replace(values, parallelState);
assertEqual(parallelState, javascript.state);

const javascriptBuild = await measureResident(
  "build/js-hash+register-update+estimate",
  timing,
  () => {
    javascript.reset().addU32Many(values);
    sink ^= javascript.estimate() | 0;
  },
);
const wasmBuild = await measureResident(
  "build/wasm-copy+hash+register-update+estimate",
  timing,
  () => {
    workspace.buildShard(0, values);
    sink ^= workspace.estimateShard(0) | 0;
  },
);
const parallelBuild = await measureResident(
  "build/persistent-workers+simd-merge+estimate",
  timing,
  async () => {
    sink ^= await parallel.replace(values, parallelState) | 0;
  },
);
const javascriptMerge = await measureResident("merge/js-8-shards+copy-out", timing, () => {
  mergeJavaScriptStates(shardStates, mergedJavaScript);
  sink ^= mergedJavaScript[0]!;
});
const wasmMerge = await measureResident("merge/wasm-simd-8-shards+copy-out", timing, () => {
  workspace.mergeInto(SHARDS, mergedWasm);
  sink ^= mergedWasm[0]!;
});
const estimator = await measureResident("estimate/js-fgra", timing, () => {
  sink ^= estimateUltraLogLog(mergedWasm, PRECISION) | 0;
});

const result = createBenchmarkResult({
  name: "ultra-log-log/isolated-build-merge",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: { rows: ROWS, distinct: DISTINCT, precision: PRECISION, shards: SHARDS },
    bytes: values.byteLength,
  },
  correctness: {
    passed: true,
    checks: 4,
    summary: "single and Worker Wasm builds plus SIMD shard merge exactly match JavaScript ULL",
  },
  measurements: [
    javascriptBuild,
    wasmBuild,
    parallelBuild,
    javascriptMerge,
    wasmMerge,
    estimator,
  ],
  metrics: {
    build_speedup: round(javascriptBuild.medianMs / wasmBuild.medianMs),
    parallel_speedup_vs_js: round(javascriptBuild.medianMs / parallelBuild.medianMs),
    parallel_speedup_vs_single_wasm: round(wasmBuild.medianMs / parallelBuild.medianMs),
    merge_speedup: round(javascriptMerge.medianMs / wasmMerge.medianMs),
    estimate,
    relative_error: round(relativeError, 6),
    register_bytes: registerCount,
    sink,
  },
  notes: [
    "Construction and module compilation are excluded; all sketches remain resident.",
    "The Wasm build includes copying the caller-owned Uint32Array into linear memory; JavaScript reads it directly.",
    "Both build paths use the same two 32-bit mixers and the same UltraLogLog register transition.",
    "The persistent-Worker row includes one shared input copy, Worker dispatch, Worker-local copies and builds, state import, SIMD merge, caller-owned output, and FGRA estimation.",
    "Both merge paths start from eight prebuilt states and materialize one caller-owned Uint8Array.",
    "UltraLogLog merge preserves two history bits and therefore cannot be replaced by unsigned byte max.",
    "FGRA estimation remains scalar TypeScript and is reported as a workload characteristic, not a speed comparison.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_ULL_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
if (Deno.env.get("JSIMD_ULL_SUMMARY") === "1") console.log(JSON.stringify(result.metrics));
else console.log(json);

function mergeJavaScriptStates(states: readonly Uint8Array[], output: Uint8Array): void {
  output.set(states[0]!);
  for (let shard = 1; shard < states.length; shard++) {
    mergeStates(output, states[shard]!, output);
  }
}

function assertEqual(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length !== expected.length) throw new Error("state length mismatch");
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`state mismatch at ${index}`);
  }
}

function mix32(value: number): number {
  value = Math.imul(value ^ value >>> 16, 0x7feb_352d);
  value = Math.imul(value ^ value >>> 15, 0x846c_a68b);
  return (value ^ value >>> 16) >>> 0;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
