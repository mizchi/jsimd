import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { type MaskedI32Aggregate, SharedI32SelectionPipeline } from "./pipeline.ts";

const ROWS = Number(Deno.env.get("JSIMD_SELECTION_ROWS") ?? 1 << 20);
const WARMUPS = Number(Deno.env.get("JSIMD_SELECTION_WARMUPS") ?? 20);
const SAMPLES = Number(Deno.env.get("JSIMD_SELECTION_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_SELECTION_OPERATIONS") ?? 5);
const measureCounts = [1, 2, 4, 8];
const first = Int32Array.from({ length: ROWS }, (_, row) => Math.imul(row, 1_103_515_245) >> 20);
const second = Int32Array.from(
  { length: ROWS },
  (_, row) => Math.imul(row ^ 0x5a5a_5a5a, 214_013) >> 18,
);
const measures = Array.from(
  { length: Math.max(...measureCounts) },
  (_, measure) =>
    Int32Array.from(
      { length: ROWS },
      (_, row) => (Math.imul(row + measure * 97, 1_664_525) >> (measure & 7)) | 0,
    ),
);
const columns = [first, second, ...measures];
const predicates = [
  { column: 0, minimum: -1_000, maximum: 1_000 },
  { column: 1, minimum: -2_000, maximum: 2_000 },
] as const;
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements = [];
const metrics: Record<string, number> = {};
let correctnessChecks = 0;
let sink = 0n;

await using pipeline = await SharedI32SelectionPipeline.create(columns);
for (const measureCount of measureCounts) {
  const measureColumns = Array.from({ length: measureCount }, (_, index) => index + 2);
  const fusedJavaScript = createFusedJavaScriptKernel(
    first,
    second,
    measures.slice(0, measureCount),
  );
  const loopJavaScript = createLoopJavaScriptKernel(
    first,
    second,
    measures.slice(0, measureCount),
  );
  const jsExpected = fusedJavaScript();
  assertAggregates(loopJavaScript(), jsExpected);
  const selected = pipeline.selectBetween(predicates);
  const wasmExpected = selected.aggregateMany(measureColumns);
  assertAggregates(wasmExpected, jsExpected);
  correctnessChecks += measureCount * 2;

  const wasm = await measureResident(
    `shared-mask/${measureCount}-measures`,
    timing,
    () => {
      const selection = pipeline.selectBetween(predicates);
      const output = selection.aggregateMany(measureColumns);
      sink ^= output.at(-1)!.sum;
    },
  );
  const unrolledJavaScript = await measureResident(
    `unrolled-js/${measureCount}-measures`,
    timing,
    () => {
      const output = fusedJavaScript();
      sink ^= output.at(-1)!.sum;
    },
  );
  const loopedJavaScript = await measureResident(
    `loop-js/${measureCount}-measures`,
    timing,
    () => {
      const output = loopJavaScript();
      sink ^= output.at(-1)!.sum;
    },
  );
  measurements.push(wasm, unrolledJavaScript, loopedJavaScript);
  const bestJavaScriptMs = Math.min(unrolledJavaScript.medianMs, loopedJavaScript.medianMs);
  metrics[`best_js_${measureCount}_measures_ms`] = round(bestJavaScriptMs);
  metrics[`speedup_${measureCount}_measures`] = round(bestJavaScriptMs / wasm.medianMs);
}

const selectedCount = pipeline.selectBetween(predicates).selectedCount;
const result = createBenchmarkResult({
  name: "parallel-columnar-selection/reusable-mask",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS },
  input: {
    shape: { rows: ROWS, predicates: 2, measureCounts, selectedCount },
  },
  correctness: {
    passed: true,
    checks: correctnessChecks,
    summary: "all masked count/sum/min/max states match the fused JavaScript reference",
  },
  measurements,
  metrics,
  notes: [
    "Both paths evaluate two i32 range predicates and compute count/sum/min/max for every measure.",
    "The shared-mask path includes mask construction, predicate-mask AND, and every masked aggregate.",
    "The JavaScript baselines fuse predicates and all requested measures into one indexed pass.",
    "Both an unrolled projection and a dynamic measure loop are recorded; speedup uses the faster median.",
    "Its integer sums remain exactly representable and convert from Number to BigInt once per result.",
    "Resident column construction and final row-ID materialization are excluded from both paths.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const output = Deno.env.get("JSIMD_SELECTION_OUTPUT");
if (output !== undefined) await Deno.writeTextFile(output, json);
console.log(json);
if (sink === 0x7fff_ffff_ffff_ffffn) console.error("unreachable sink", sink);

function createFusedJavaScriptKernel(
  predicateA: Int32Array,
  predicateB: Int32Array,
  values: readonly Int32Array[],
): () => MaskedI32Aggregate[] {
  switch (values.length) {
    case 1:
      return () => fused1(predicateA, predicateB, values[0]!);
    case 2:
      return () => fused2(predicateA, predicateB, values[0]!, values[1]!);
    case 4:
      return () => fused4(predicateA, predicateB, values[0]!, values[1]!, values[2]!, values[3]!);
    case 8:
      return () =>
        fused8(
          predicateA,
          predicateB,
          values[0]!,
          values[1]!,
          values[2]!,
          values[3]!,
          values[4]!,
          values[5]!,
          values[6]!,
          values[7]!,
        );
    default:
      throw new RangeError("unsupported measure count");
  }
}

function createLoopJavaScriptKernel(
  predicateA: Int32Array,
  predicateB: Int32Array,
  values: readonly Int32Array[],
): () => MaskedI32Aggregate[] {
  return () => {
    let count = 0;
    const sums = new Float64Array(values.length);
    const minimums = new Int32Array(values.length).fill(0x7fff_ffff);
    const maximums = new Int32Array(values.length).fill(-0x8000_0000);
    for (let row = 0; row < predicateA.length; row++) {
      const left = predicateA[row]!, right = predicateB[row]!;
      if (left < -1_000 || left >= 1_000 || right < -2_000 || right >= 2_000) continue;
      count++;
      for (let measure = 0; measure < values.length; measure++) {
        const value = values[measure]![row]!;
        sums[measure] += value;
        if (value < minimums[measure]!) minimums[measure] = value;
        if (value > maximums[measure]!) maximums[measure] = value;
      }
    }
    return values.map((_, measure) =>
      aggregate(count, sums[measure]!, minimums[measure]!, maximums[measure]!)
    );
  };
}

function fused1(a: Int32Array, b: Int32Array, v0: Int32Array): MaskedI32Aggregate[] {
  let count = 0, s0 = 0, lo0 = 0x7fff_ffff, hi0 = -0x8000_0000;
  for (let row = 0; row < a.length; row++) {
    const left = a[row]!, right = b[row]!;
    if (left < -1_000 || left >= 1_000 || right < -2_000 || right >= 2_000) continue;
    count++;
    const x0 = v0[row]!;
    s0 += x0;
    if (x0 < lo0) lo0 = x0;
    if (x0 > hi0) hi0 = x0;
  }
  return [aggregate(count, s0, lo0, hi0)];
}

function fused2(
  a: Int32Array,
  b: Int32Array,
  v0: Int32Array,
  v1: Int32Array,
): MaskedI32Aggregate[] {
  let count = 0;
  let s0 = 0, lo0 = 0x7fff_ffff, hi0 = -0x8000_0000;
  let s1 = 0, lo1 = 0x7fff_ffff, hi1 = -0x8000_0000;
  for (let row = 0; row < a.length; row++) {
    const left = a[row]!, right = b[row]!;
    if (left < -1_000 || left >= 1_000 || right < -2_000 || right >= 2_000) continue;
    count++;
    const x0 = v0[row]!, x1 = v1[row]!;
    s0 += x0;
    if (x0 < lo0) lo0 = x0;
    if (x0 > hi0) hi0 = x0;
    s1 += x1;
    if (x1 < lo1) lo1 = x1;
    if (x1 > hi1) hi1 = x1;
  }
  return [aggregate(count, s0, lo0, hi0), aggregate(count, s1, lo1, hi1)];
}

function fused4(
  a: Int32Array,
  b: Int32Array,
  v0: Int32Array,
  v1: Int32Array,
  v2: Int32Array,
  v3: Int32Array,
): MaskedI32Aggregate[] {
  let count = 0;
  let s0 = 0, lo0 = 0x7fff_ffff, hi0 = -0x8000_0000;
  let s1 = 0, lo1 = 0x7fff_ffff, hi1 = -0x8000_0000;
  let s2 = 0, lo2 = 0x7fff_ffff, hi2 = -0x8000_0000;
  let s3 = 0, lo3 = 0x7fff_ffff, hi3 = -0x8000_0000;
  for (let row = 0; row < a.length; row++) {
    const left = a[row]!, right = b[row]!;
    if (left < -1_000 || left >= 1_000 || right < -2_000 || right >= 2_000) continue;
    count++;
    const x0 = v0[row]!, x1 = v1[row]!, x2 = v2[row]!, x3 = v3[row]!;
    s0 += x0;
    if (x0 < lo0) lo0 = x0;
    if (x0 > hi0) hi0 = x0;
    s1 += x1;
    if (x1 < lo1) lo1 = x1;
    if (x1 > hi1) hi1 = x1;
    s2 += x2;
    if (x2 < lo2) lo2 = x2;
    if (x2 > hi2) hi2 = x2;
    s3 += x3;
    if (x3 < lo3) lo3 = x3;
    if (x3 > hi3) hi3 = x3;
  }
  return [
    aggregate(count, s0, lo0, hi0),
    aggregate(count, s1, lo1, hi1),
    aggregate(count, s2, lo2, hi2),
    aggregate(count, s3, lo3, hi3),
  ];
}

function fused8(
  a: Int32Array,
  b: Int32Array,
  v0: Int32Array,
  v1: Int32Array,
  v2: Int32Array,
  v3: Int32Array,
  v4: Int32Array,
  v5: Int32Array,
  v6: Int32Array,
  v7: Int32Array,
): MaskedI32Aggregate[] {
  let count = 0;
  let s0 = 0, lo0 = 0x7fff_ffff, hi0 = -0x8000_0000;
  let s1 = 0, lo1 = 0x7fff_ffff, hi1 = -0x8000_0000;
  let s2 = 0, lo2 = 0x7fff_ffff, hi2 = -0x8000_0000;
  let s3 = 0, lo3 = 0x7fff_ffff, hi3 = -0x8000_0000;
  let s4 = 0, lo4 = 0x7fff_ffff, hi4 = -0x8000_0000;
  let s5 = 0, lo5 = 0x7fff_ffff, hi5 = -0x8000_0000;
  let s6 = 0, lo6 = 0x7fff_ffff, hi6 = -0x8000_0000;
  let s7 = 0, lo7 = 0x7fff_ffff, hi7 = -0x8000_0000;
  for (let row = 0; row < a.length; row++) {
    const left = a[row]!, right = b[row]!;
    if (left < -1_000 || left >= 1_000 || right < -2_000 || right >= 2_000) continue;
    count++;
    const x0 = v0[row]!, x1 = v1[row]!, x2 = v2[row]!, x3 = v3[row]!;
    const x4 = v4[row]!, x5 = v5[row]!, x6 = v6[row]!, x7 = v7[row]!;
    s0 += x0;
    if (x0 < lo0) lo0 = x0;
    if (x0 > hi0) hi0 = x0;
    s1 += x1;
    if (x1 < lo1) lo1 = x1;
    if (x1 > hi1) hi1 = x1;
    s2 += x2;
    if (x2 < lo2) lo2 = x2;
    if (x2 > hi2) hi2 = x2;
    s3 += x3;
    if (x3 < lo3) lo3 = x3;
    if (x3 > hi3) hi3 = x3;
    s4 += x4;
    if (x4 < lo4) lo4 = x4;
    if (x4 > hi4) hi4 = x4;
    s5 += x5;
    if (x5 < lo5) lo5 = x5;
    if (x5 > hi5) hi5 = x5;
    s6 += x6;
    if (x6 < lo6) lo6 = x6;
    if (x6 > hi6) hi6 = x6;
    s7 += x7;
    if (x7 < lo7) lo7 = x7;
    if (x7 > hi7) hi7 = x7;
  }
  return [
    aggregate(count, s0, lo0, hi0),
    aggregate(count, s1, lo1, hi1),
    aggregate(count, s2, lo2, hi2),
    aggregate(count, s3, lo3, hi3),
    aggregate(count, s4, lo4, hi4),
    aggregate(count, s5, lo5, hi5),
    aggregate(count, s6, lo6, hi6),
    aggregate(count, s7, lo7, hi7),
  ];
}

function aggregate(count: number, sum: number, min: number, max: number): MaskedI32Aggregate {
  return { count, sum: BigInt(sum), min: count === 0 ? 0 : min, max: count === 0 ? 0 : max };
}

function assertAggregates(
  actual: readonly MaskedI32Aggregate[],
  expected: readonly MaskedI32Aggregate[],
): void {
  if (actual.length !== expected.length) throw new Error("aggregate length mismatch");
  for (let index = 0; index < expected.length; index++) {
    const left = actual[index]!;
    const right = expected[index]!;
    if (
      left.count !== right.count || left.sum !== right.sum || left.min !== right.min ||
      left.max !== right.max
    ) throw new Error(`aggregate mismatch at measure ${index}`);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
