import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, packF32GemmRight, packF32GemmRightInto } from "./mod.ts";

const SHAPES = [
  { name: "64x64x64", rows: 64, inner: 64, columns: 64 },
  { name: "128x128x128", rows: 128, inner: 128, columns: 128 },
  { name: "256x256x256", rows: 256, inner: 256, columns: 256 },
  { name: "32x256x1024", rows: 32, inner: 256, columns: 1024 },
  { name: "16x512x4096", rows: 16, inner: 512, columns: 4096 },
  { name: "512x256x32", rows: 512, inner: 256, columns: 32 },
] as const;
const ROW_TILE = 4;
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_PACK_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_PACK_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_PACK_OPERATIONS") ?? 8);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const shape of SHAPES) {
  const plan = { ...shape, rowTile: ROW_TILE as 4, innerLoop: "unroll4" as const };
  const aElements = shape.rows * shape.inner;
  const bElements = shape.inner * shape.columns;
  const cElements = shape.rows * shape.columns;
  const aBytes = align16(aElements * 4);
  const bBytes = align16(bElements * 4);
  const cBytes = align16(cElements * 4);
  const bValues = new Float32Array(bElements);
  fill(bValues, 29, 97);
  const initialPacked = packF32GemmRight(plan, bValues);
  const packedBytes = align16(initialPacked.byteLength);
  const aPointer = 0;
  const bPointer = aBytes;
  const packedBPointer = bPointer + bBytes;
  const rowMajorOutputPointer = packedBPointer + packedBytes;
  const packedOutputPointer = rowMajorOutputPointer + cBytes;
  const memoryBytes = packedOutputPointer + cBytes;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil(memoryBytes / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const b = new Float32Array(memory.buffer, bPointer, bElements);
  const packedB = new Float32Array(memory.buffer, packedBPointer, initialPacked.length);
  const rowMajorOutput = new Float32Array(memory.buffer, rowMajorOutputPointer, cElements);
  const packedOutput = new Float32Array(memory.buffer, packedOutputPointer, cElements);
  fill(a, 17, 101);
  b.set(bValues);
  packedB.set(initialPacked);

  const [rowMajorCompiled, packedCompiled] = await Promise.all([
    compileF32Gemm(plan),
    compileF32Gemm({ ...plan, rightLayout: "packed-panels" }),
  ]);
  const [rowMajorKernel, packedKernel] = await Promise.all([
    rowMajorCompiled.instantiate(memory),
    packedCompiled.instantiate(memory),
  ]);
  rowMajorKernel.run(aPointer, bPointer, rowMajorOutputPointer, 0);
  packedKernel.run(aPointer, packedBPointer, packedOutputPointer, 0);
  assertClose(packedOutput, rowMajorOutput, shape.name);

  for (let iteration = 0; iteration < 256; iteration++) {
    rowMajorKernel.run(aPointer, bPointer, rowMajorOutputPointer, 0);
    packedKernel.run(aPointer, packedBPointer, packedOutputPointer, 0);
  }

  const rowMajor = await measureResident(`gemm-pack/${shape.name}/row-major`, timing, () => {
    rowMajorKernel.run(aPointer, bPointer, rowMajorOutputPointer, 0);
    sink += rowMajorOutput[cElements - 1]!;
  });
  const packed = await measureResident(`gemm-pack/${shape.name}/packed-resident`, timing, () => {
    packedKernel.run(aPointer, packedBPointer, packedOutputPointer, 0);
    sink += packedOutput[cElements - 1]!;
  });
  const packCopy = await measureResident(`gemm-pack/${shape.name}/pack-copy`, timing, () => {
    packF32GemmRightInto(plan, bValues, packedB);
    sink += packedB[packedB.length - 1]!;
  });
  measurements.push(rowMajor, packed, packCopy);
  metrics[`${shape.name}_row_major_ms`] = round(rowMajor.medianMs, 6);
  metrics[`${shape.name}_packed_resident_ms`] = round(packed.medianMs, 6);
  metrics[`${shape.name}_pack_copy_ms`] = round(packCopy.medianMs, 6);
  metrics[`${shape.name}_resident_speedup`] = round(rowMajor.medianMs / packed.medianMs);
  metrics[`${shape.name}_one_shot_ratio`] = round(
    (packCopy.medianMs + packed.medianMs) / rowMajor.medianMs,
  );
  const savedPerCall = rowMajor.medianMs - packed.medianMs;
  metrics[`${shape.name}_packing_break_even_calls`] = savedPerCall > 0
    ? Math.ceil(packCopy.medianMs / savedPerCall)
    : 0;
  metrics[`${shape.name}_packed_bytes`] = initialPacked.byteLength;
  metrics[`${shape.name}_padding_ratio`] = round(initialPacked.length / bElements, 4);
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-packed-b",
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
    summary: "packed-panel GEMM matches the row-major generated kernel",
  },
  measurements,
  metrics,
  notes: [
    "Packed B uses panel-major [column panel][K][NR] storage with zero padding in the final panel.",
    "Resident timing excludes packing; pack-copy measures reusable JavaScript packing into Wasm memory.",
    "The one-shot ratio estimates (pack-copy + packed compute) / row-major compute; below one wins.",
    "A zero packing break-even means packed resident compute did not beat row-major compute.",
    "Both compute paths use strict SIMD, MR=4, NR=8, factor-four K unrolling, and pointer induction.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_PACK_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_PACK_SUMMARY") === "1") console.log(JSON.stringify(metrics));
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
