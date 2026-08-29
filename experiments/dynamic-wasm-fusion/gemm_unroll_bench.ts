import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, type F32GemmInnerLoop } from "./mod.ts";

const INNER_SIZES = [4, 8, 16, 32, 64, 128] as const;
const MODES = [
  "loop",
  "unroll2",
  "unroll4",
  "unrolled",
] as const satisfies readonly F32GemmInnerLoop[];
const ROWS = 64;
const COLUMNS = 64;
const ROW_TILE = 2;
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_UNROLL_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_UNROLL_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_UNROLL_OPERATIONS") ?? 16);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const inner of INNER_SIZES) {
  const aElements = ROWS * inner;
  const bElements = inner * COLUMNS;
  const cElements = ROWS * COLUMNS;
  const aBytes = align16(aElements * 4);
  const bBytes = align16(bElements * 4);
  const cBytes = align16(cElements * 4);
  const aPointer = 0;
  const bPointer = aBytes;
  const outputBase = bPointer + bBytes;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil((outputBase + cBytes * MODES.length) / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const b = new Float32Array(memory.buffer, bPointer, bElements);
  fill(a, 17, 101);
  fill(b, 29, 97);

  const kernels = [];
  for (let index = 0; index < MODES.length; index++) {
    const innerLoop = MODES[index]!;
    const compileStarted = performance.now();
    const compiled = await compileF32Gemm({
      rows: ROWS,
      inner,
      columns: COLUMNS,
      rowTile: ROW_TILE,
      innerLoop,
    });
    const compileMs = performance.now() - compileStarted;
    const instantiateStarted = performance.now();
    const instance = await compiled.instantiate(memory);
    const instantiateMs = performance.now() - instantiateStarted;
    kernels.push({
      innerLoop,
      bytes: compiled.bytes.byteLength,
      compileMs,
      instantiateMs,
      outputPointer: outputBase + cBytes * index,
      instance,
    });
  }

  for (const kernel of kernels) {
    kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
  }
  const expected = new Float32Array(memory.buffer, kernels[0]!.outputPointer, cElements);
  for (const kernel of kernels.slice(1)) {
    assertClose(
      new Float32Array(memory.buffer, kernel.outputPointer, cElements),
      expected,
      `k${inner}/${kernel.innerLoop}`,
    );
  }
  for (let iteration = 0; iteration < 512; iteration++) {
    for (const kernel of kernels) {
      kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
    }
  }

  const shapeMeasurements: BenchmarkMeasurement[] = [];
  for (const kernel of kernels) {
    const measurement = await measureResident(
      `gemm-unroll/64x${inner}x64/${kernel.innerLoop}`,
      timing,
      () => {
        kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
        sink += new Float32Array(memory.buffer, kernel.outputPointer, cElements)[cElements - 1]!;
      },
    );
    measurements.push(measurement);
    shapeMeasurements.push(measurement);
    metrics[`k${inner}_${kernel.innerLoop}_ms`] = round(measurement.medianMs, 6);
    metrics[`k${inner}_${kernel.innerLoop}_bytes`] = kernel.bytes;
    metrics[`k${inner}_${kernel.innerLoop}_compile_ms`] = round(kernel.compileMs, 4);
    metrics[`k${inner}_${kernel.innerLoop}_instantiate_ms`] = round(kernel.instantiateMs, 4);
  }
  const looped = shapeMeasurements[0]!.medianMs;
  for (let index = 1; index < MODES.length; index++) {
    const mode = MODES[index]!;
    const candidate = shapeMeasurements[index]!.medianMs;
    metrics[`k${inner}_${mode}_speedup`] = round(looped / candidate);
    const coldCost = kernels[index]!.compileMs + kernels[index]!.instantiateMs;
    const savedPerCall = looped - candidate;
    metrics[`k${inner}_${mode}_break_even_calls`] = savedPerCall > 0
      ? Math.ceil(coldCost / savedPerCall)
      : -1;
  }
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-inner-unroll",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: { rows: ROWS, inner: INNER_SIZES, columns: COLUMNS, rowTile: ROW_TILE },
    bytes: (ROWS * Math.max(...INNER_SIZES) + Math.max(...INNER_SIZES) * COLUMNS +
      ROWS * COLUMNS) * 4,
  },
  correctness: {
    passed: true,
    checks: INNER_SIZES.length * (MODES.length - 1),
    summary: "bounded and fully unrolled inner dimensions match the generated loop kernel",
  },
  measurements,
  metrics,
  notes: [
    "All paths use A/B pointer induction; bounded modes process two or four K steps per branch.",
    "The fully unrolled path emits no runtime K loop and uses constant offsets from the induced pointers.",
    "All paths use strict SIMD multiply plus add and an MR=2, NR=16 register tile.",
    "Resident timing excludes compilation and instantiation; their cold cost is reported separately.",
    "Break-even compares unrolled cold compile plus instantiate cost with resident savings over the loop.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_UNROLL_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_UNROLL_SUMMARY") === "1") console.log(JSON.stringify(metrics));
else console.log(json);

function fill(values: Float32Array, multiplier: number, modulus: number): void {
  for (let index = 0; index < values.length; index++) {
    values[index] = ((index * multiplier + 3) % modulus - Math.floor(modulus / 2)) / 32;
  }
}

function assertClose(actual: Float32Array, expected: Float32Array, label: string): void {
  for (let index = 0; index < actual.length; index++) {
    const tolerance = Math.max(1e-4, Math.abs(expected[index]!) * 2e-5);
    if (Math.abs(actual[index]! - expected[index]!) <= tolerance) continue;
    throw new Error(
      `${label} mismatch at ${index}: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
