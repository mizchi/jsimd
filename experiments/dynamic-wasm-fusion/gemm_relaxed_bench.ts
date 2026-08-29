import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, type F32GemmMultiplyAdd } from "./mod.ts";

const SHAPES = [
  { name: "64x64x64", rows: 64, inner: 64, columns: 64, rowTile: 2 as const },
  { name: "128x128x128", rows: 128, inner: 128, columns: 128, rowTile: 2 as const },
  { name: "256x128x32", rows: 256, inner: 128, columns: 32, rowTile: 2 as const },
  { name: "32x128x256", rows: 32, inner: 128, columns: 256, rowTile: 4 as const },
] as const;
const MODES = ["strict", "relaxed"] as const satisfies readonly F32GemmMultiplyAdd[];
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_RELAXED_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_RELAXED_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_RELAXED_OPERATIONS") ?? 16);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const shape of SHAPES) {
  const aElements = shape.rows * shape.inner;
  const bElements = shape.inner * shape.columns;
  const cElements = shape.rows * shape.columns;
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

  const kernels = await Promise.all(MODES.map(async (multiplyAdd, index) => {
    const compiled = await compileF32Gemm({ ...shape, multiplyAdd });
    return {
      multiplyAdd,
      bytes: compiled.bytes.byteLength,
      outputPointer: outputBase + cBytes * index,
      instance: await compiled.instantiate(memory),
    };
  }));
  for (const kernel of kernels) {
    kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
  }
  assertClose(
    new Float32Array(memory.buffer, kernels[1]!.outputPointer, cElements),
    new Float32Array(memory.buffer, kernels[0]!.outputPointer, cElements),
    shape.name,
  );
  for (let iteration = 0; iteration < 64; iteration++) {
    for (const kernel of kernels) {
      kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
    }
  }

  const shapeMeasurements: BenchmarkMeasurement[] = [];
  for (const kernel of kernels) {
    const measurement = await measureResident(
      `gemm-relaxed/${shape.name}/${kernel.multiplyAdd}`,
      timing,
      () => {
        kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
        sink += new Float32Array(memory.buffer, kernel.outputPointer, cElements)[cElements - 1]!;
      },
    );
    measurements.push(measurement);
    shapeMeasurements.push(measurement);
    metrics[`${shape.name}_${kernel.multiplyAdd}_ms`] = round(measurement.medianMs, 6);
    metrics[`${shape.name}_${kernel.multiplyAdd}_bytes`] = kernel.bytes;
  }
  metrics[`${shape.name}_relaxed_speedup`] = round(
    shapeMeasurements[0]!.medianMs / shapeMeasurements[1]!.medianMs,
  );
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-relaxed-madd",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: {
      rows: SHAPES.map((shape) => shape.rows),
      inner: SHAPES.map((shape) => shape.inner),
      columns: SHAPES.map((shape) => shape.columns),
      rowTiles: SHAPES.map((shape) => shape.rowTile),
    },
    bytes: Math.max(
      ...SHAPES.map((shape) =>
        (shape.rows * shape.inner + shape.inner * shape.columns + shape.rows * shape.columns) * 4
      ),
    ),
  },
  correctness: {
    passed: true,
    checks: SHAPES.length,
    summary: "relaxed multiply-add agrees with strict SIMD within an f32-relative tolerance",
  },
  measurements,
  metrics,
  notes: [
    "Relaxed SIMD may map multiply-add to hardware FMA and may change floating-point rounding.",
    "MR=2 is used except for the wide shape, where the row-tile experiment selected MR=4.",
    "Timing is resident and excludes module generation, compilation, instantiation, and input copies.",
    "Scalar column tails remain strict because relaxed SIMD only applies to v128 lanes.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_RELAXED_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_RELAXED_SUMMARY") === "1") console.log(JSON.stringify(metrics));
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
