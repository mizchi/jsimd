import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, packF32GemmRight } from "./mod.ts";

const SHAPES = [
  { name: "256x256x256", rows: 256, inner: 256, columns: 256 },
  { name: "1024x256x256", rows: 1024, inner: 256, columns: 256 },
  { name: "256x512x1024", rows: 256, inner: 512, columns: 1024 },
  { name: "16x512x4096", rows: 16, inner: 512, columns: 4096 },
  { name: "64x2048x2048", rows: 64, inner: 2048, columns: 2048 },
] as const;
const COLUMN_BLOCKS = [8, 32, 64, 128, 256] as const;
const ROW_TILE = 4;
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_BLOCK_WARMUPS") ?? 8);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_BLOCK_SAMPLES") ?? 15);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_BLOCK_OPERATIONS") ?? 4);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const shape of SHAPES) {
  const plan = {
    ...shape,
    rowTile: ROW_TILE as 4,
    innerLoop: "unroll4" as const,
    rightLayout: "packed-panels" as const,
  };
  const aElements = shape.rows * shape.inner;
  const bElements = shape.inner * shape.columns;
  const cElements = shape.rows * shape.columns;
  const aBytes = align16(aElements * 4);
  const packedBValues = packF32GemmRight(
    plan,
    Float32Array.from(
      { length: bElements },
      (_, index) => ((index * 29 + 3) % 97 - 48) / 64,
    ),
  );
  const packedBBytes = align16(packedBValues.byteLength);
  const aPointer = 0;
  const bPointer = aBytes;
  const outputPointer = bPointer + packedBBytes;
  const memoryBytes = outputPointer + cElements * 4;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil(memoryBytes / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const packedB = new Float32Array(memory.buffer, bPointer, packedBValues.length);
  const output = new Float32Array(memory.buffer, outputPointer, cElements);
  fill(a, 17, 101);
  packedB.set(packedBValues);

  const candidates = [
    { name: "unblocked", columnBlock: undefined },
    ...COLUMN_BLOCKS.filter((columnBlock) => columnBlock <= shape.columns).map(
      (columnBlock) => ({ name: `nc${columnBlock}`, columnBlock }),
    ),
  ];
  const compiled = await Promise.all(
    candidates.map((candidate) =>
      compileF32Gemm({
        ...plan,
        columnBlock: candidate.columnBlock,
      })
    ),
  );
  const kernels = await Promise.all(compiled.map((candidate) => candidate.instantiate(memory)));
  kernels[0]!.run(aPointer, bPointer, outputPointer, 0);
  const expected = new Float32Array(output);
  for (let index = 1; index < kernels.length; index++) {
    output.fill(Number.NaN);
    kernels[index]!.run(aPointer, bPointer, outputPointer, 0);
    assertClose(output, expected, `${shape.name}/${candidates[index]!.name}`);
  }

  const candidateMeasurements: BenchmarkMeasurement[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const kernel = kernels[index]!;
    const measurement = await measureResident(
      `gemm-block/${shape.name}/${candidate.name}`,
      timing,
      () => {
        kernel.run(aPointer, bPointer, outputPointer, 0);
        sink += output[cElements - 1]!;
      },
    );
    measurements.push(measurement);
    candidateMeasurements.push(measurement);
    metrics[`${shape.name}_${candidate.name}_ms`] = round(measurement.medianMs, 6);
    metrics[`${shape.name}_${candidate.name}_module_bytes`] = compiled[index]!.bytes.byteLength;
  }
  const baseline = candidateMeasurements[0]!.medianMs;
  let bestIndex = 0;
  for (let index = 1; index < candidateMeasurements.length; index++) {
    if (candidateMeasurements[index]!.medianMs < candidateMeasurements[bestIndex]!.medianMs) {
      bestIndex = index;
    }
  }
  metrics[`${shape.name}_best_nc`] = candidates[bestIndex]!.columnBlock ?? 0;
  metrics[`${shape.name}_best_speedup`] = round(
    baseline / candidateMeasurements[bestIndex]!.medianMs,
  );
  metrics[`${shape.name}_packed_b_bytes`] = packedBValues.byteLength;
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-cache-blocking",
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
      rowTile: ROW_TILE,
      innerLoop: "unroll4",
      columnBlocks: COLUMN_BLOCKS,
    },
    bytes: Math.max(
      ...SHAPES.map((shape) =>
        (shape.rows * shape.inner + shape.inner * shape.columns + shape.rows * shape.columns) * 4
      ),
    ),
  },
  correctness: {
    passed: true,
    checks: SHAPES.reduce(
      (sum, shape) => sum + COLUMN_BLOCKS.filter((block) => block <= shape.columns).length,
      0,
    ),
    summary: "NC-blocked packed-panel GEMM matches the unblocked generated kernel",
  },
  measurements,
  metrics,
  notes: [
    "NC blocking changes traversal from row-tile/whole-B to column-block/row-tile/panel.",
    "All paths consume the same resident packed B, excluding one-time JavaScript packing.",
    "NC values are multiples of the MR=4, NR=8 packed panel width.",
    "No KC split is applied, so C is written only once and the complete KxNC B block is the cache working set.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_BLOCK_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_BLOCK_SUMMARY") === "1") console.log(JSON.stringify(metrics));
else console.log(json);

function fill(values: Float32Array, multiplier: number, modulus: number): void {
  for (let index = 0; index < values.length; index++) {
    values[index] = ((index * multiplier + 3) % modulus - Math.floor(modulus / 2)) / 64;
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
