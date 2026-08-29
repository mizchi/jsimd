import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, type F32GemmRowTile } from "./mod.ts";

const SHAPES = [
  { name: "16x16x16", rows: 16, inner: 16, columns: 16 },
  { name: "64x64x64", rows: 64, inner: 64, columns: 64 },
  { name: "128x128x128", rows: 128, inner: 128, columns: 128 },
  { name: "256x128x32", rows: 256, inner: 128, columns: 32 },
  { name: "32x128x256", rows: 32, inner: 128, columns: 256 },
] as const;
const ROW_TILES = [1, 2, 4, 8] as const satisfies readonly F32GemmRowTile[];
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_TILE_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_TILE_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_TILE_OPERATIONS") ?? 16);
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
  const memoryBytes = outputBase + cBytes * ROW_TILES.length;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil(memoryBytes / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const b = new Float32Array(memory.buffer, bPointer, bElements);
  fill(a, 17, 101);
  fill(b, 29, 97);

  const kernels = await Promise.all(ROW_TILES.map(async (rowTile, index) => {
    const compiled = await compileF32Gemm({ ...shape, rowTile });
    return {
      rowTile,
      bytes: compiled.bytes.byteLength,
      outputPointer: outputBase + cBytes * index,
      instance: await compiled.instantiate(memory),
    };
  }));

  for (const kernel of kernels) {
    kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
  }
  const expected = new Float32Array(memory.buffer, kernels[0]!.outputPointer, cElements);
  for (const kernel of kernels.slice(1)) {
    assertClose(
      new Float32Array(memory.buffer, kernel.outputPointer, cElements),
      expected,
      `${shape.name}/mr${kernel.rowTile}`,
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
      `gemm-row-tile/${shape.name}/mr${kernel.rowTile}nr${32 / kernel.rowTile}`,
      timing,
      () => {
        kernel.instance.run(aPointer, bPointer, kernel.outputPointer, 0);
        sink += new Float32Array(memory.buffer, kernel.outputPointer, cElements)[cElements - 1]!;
      },
    );
    measurements.push(measurement);
    shapeMeasurements.push(measurement);
    metrics[`${shape.name}_mr${kernel.rowTile}_ms`] = round(measurement.medianMs, 6);
    metrics[`${shape.name}_mr${kernel.rowTile}_bytes`] = kernel.bytes;
  }
  const baseline = shapeMeasurements[0]!.medianMs;
  let bestIndex = 0;
  for (let index = 1; index < shapeMeasurements.length; index++) {
    if (shapeMeasurements[index]!.medianMs < shapeMeasurements[bestIndex]!.medianMs) {
      bestIndex = index;
    }
  }
  metrics[`${shape.name}_best_row_tile`] = ROW_TILES[bestIndex]!;
  metrics[`${shape.name}_best_speedup_vs_mr1`] = round(
    baseline / shapeMeasurements[bestIndex]!.medianMs,
  );
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-row-tiles",
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
      rowTiles: ROW_TILES,
    },
    bytes: Math.max(
      ...SHAPES.map((shape) =>
        (shape.rows * shape.inner + shape.inner * shape.columns + shape.rows * shape.columns) * 4
      ),
    ),
  },
  correctness: {
    passed: true,
    checks: SHAPES.length * (ROW_TILES.length - 1),
    summary: "all multi-row register tiles match the MR=1 generated kernel",
  },
  measurements,
  metrics,
  notes: [
    "MR denotes output rows and NR denotes output columns retained across the inner loop.",
    "All variants use eight v128 accumulators; MR>1 loads each B vector once and reuses it across rows.",
    "Timing is resident and excludes module generation, compilation, instantiation, and input copies.",
    "The kernels compute pure row-major f32 GEMM without packing, cache blocking, or an epilogue.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_TILE_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_TILE_SUMMARY") === "1") console.log(JSON.stringify(metrics));
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
