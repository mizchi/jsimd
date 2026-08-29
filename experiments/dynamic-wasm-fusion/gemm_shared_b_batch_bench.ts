import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { compileF32Gemm, packF32GemmRight } from "./mod.ts";

const CASES = [
  { name: "4x16x512x4096", batch: 4, rows: 16, inner: 512, columns: 4096 },
  { name: "16x16x512x4096", batch: 16, rows: 16, inner: 512, columns: 4096 },
  { name: "4x4x2048x2048", batch: 4, rows: 4, inner: 2048, columns: 2048 },
  { name: "16x4x2048x2048", batch: 16, rows: 4, inner: 2048, columns: 2048 },
] as const;
const ROW_TILE = 4;
const COLUMN_BLOCK = 64;
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_BATCH_WARMUPS") ?? 4);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_BATCH_SAMPLES") ?? 11);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_BATCH_OPERATIONS") ?? 1);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const candidate of CASES) {
  const singlePlan = {
    rows: candidate.rows,
    inner: candidate.inner,
    columns: candidate.columns,
    rowTile: ROW_TILE as 4,
    innerLoop: "unroll4" as const,
    rightLayout: "packed-panels" as const,
  };
  const batchedPlan = { ...singlePlan, rows: candidate.batch * candidate.rows };
  const singleBlockedPlan = { ...singlePlan, columnBlock: COLUMN_BLOCK };
  const batchedBlockedPlan = { ...batchedPlan, columnBlock: COLUMN_BLOCK };
  const aMatrixElements = candidate.rows * candidate.inner;
  const cMatrixElements = candidate.rows * candidate.columns;
  const aElements = candidate.batch * aMatrixElements;
  const cElements = candidate.batch * cMatrixElements;
  const bElements = candidate.inner * candidate.columns;
  const packedBValues = packF32GemmRight(
    singlePlan,
    Float32Array.from(
      { length: bElements },
      (_, index) => ((index * 29 + 3) % 97 - 48) / 64,
    ),
  );
  const aPointer = 0;
  const bPointer = align16(aElements * 4);
  const separateOutputPointer = bPointer + align16(packedBValues.byteLength);
  const batchedOutputPointer = separateOutputPointer + align16(cElements * 4);
  const memoryBytes = batchedOutputPointer + cElements * 4;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil(memoryBytes / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const packedB = new Float32Array(memory.buffer, bPointer, packedBValues.length);
  const separateOutput = new Float32Array(
    memory.buffer,
    separateOutputPointer,
    cElements,
  );
  const batchedOutput = new Float32Array(memory.buffer, batchedOutputPointer, cElements);
  fill(a, 17, 101);
  packedB.set(packedBValues);

  const [single, batched, singleBlocked, batchedBlocked] = await Promise.all([
    compileF32Gemm(singlePlan),
    compileF32Gemm(batchedPlan),
    compileF32Gemm(singleBlockedPlan),
    compileF32Gemm(batchedBlockedPlan),
  ]);
  const [singleKernel, batchedKernel, singleBlockedKernel, batchedBlockedKernel] = await Promise
    .all([
      single.instantiate(memory),
      batched.instantiate(memory),
      singleBlocked.instantiate(memory),
      batchedBlocked.instantiate(memory),
    ]);
  const runSeparate = (
    run: (aPointer: number, bPointer: number, cPointer: number, biasPointer: number) => void,
  ): void => {
    for (let batch = 0; batch < candidate.batch; batch++) {
      run(
        aPointer + batch * aMatrixElements * 4,
        bPointer,
        separateOutputPointer + batch * cMatrixElements * 4,
        0,
      );
    }
  };

  runSeparate(singleKernel.run);
  batchedOutput.fill(Number.NaN);
  batchedKernel.run(aPointer, bPointer, batchedOutputPointer, 0);
  assertClose(batchedOutput, separateOutput, `${candidate.name}/batched-unblocked`);
  separateOutput.fill(Number.NaN);
  runSeparate(singleBlockedKernel.run);
  assertClose(separateOutput, batchedOutput, `${candidate.name}/separate-nc${COLUMN_BLOCK}`);
  batchedOutput.fill(Number.NaN);
  batchedBlockedKernel.run(aPointer, bPointer, batchedOutputPointer, 0);
  assertClose(batchedOutput, separateOutput, `${candidate.name}/batched-nc${COLUMN_BLOCK}`);

  const variants = [
    {
      name: "separate-unblocked",
      run: () => runSeparate(singleKernel.run),
      output: separateOutput,
      moduleBytes: single.bytes.byteLength,
    },
    {
      name: "batched-unblocked",
      run: () => batchedKernel.run(aPointer, bPointer, batchedOutputPointer, 0),
      output: batchedOutput,
      moduleBytes: batched.bytes.byteLength,
    },
    {
      name: `separate-nc${COLUMN_BLOCK}`,
      run: () => runSeparate(singleBlockedKernel.run),
      output: separateOutput,
      moduleBytes: singleBlocked.bytes.byteLength,
    },
    {
      name: `batched-nc${COLUMN_BLOCK}`,
      run: () => batchedBlockedKernel.run(aPointer, bPointer, batchedOutputPointer, 0),
      output: batchedOutput,
      moduleBytes: batchedBlocked.bytes.byteLength,
    },
  ];
  const caseMeasurements: BenchmarkMeasurement[] = [];
  for (const variant of variants) {
    const measurement = await measureResident(
      `gemm-shared-b/${candidate.name}/${variant.name}`,
      timing,
      () => {
        variant.run();
        sink += variant.output[cElements - 1]!;
      },
    );
    measurements.push(measurement);
    caseMeasurements.push(measurement);
    metrics[`${candidate.name}_${variant.name}_ms`] = round(measurement.medianMs, 6);
    metrics[`${candidate.name}_${variant.name}_module_bytes`] = variant.moduleBytes;
  }
  const separateUnblockedMs = caseMeasurements[0]!.medianMs;
  const batchedUnblockedMs = caseMeasurements[1]!.medianMs;
  const batchedBlockedMs = caseMeasurements[3]!.medianMs;
  metrics[`${candidate.name}_batch_call_speedup`] = round(
    separateUnblockedMs / batchedUnblockedMs,
  );
  metrics[`${candidate.name}_batched_nc_speedup`] = round(
    batchedUnblockedMs / batchedBlockedMs,
  );
  metrics[`${candidate.name}_total_speedup`] = round(
    separateUnblockedMs / batchedBlockedMs,
  );
  metrics[`${candidate.name}_packed_b_bytes`] = packedBValues.byteLength;
}

metrics.sink = round(Math.abs(sink), 3);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm-shared-b-batch",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: {
      batch: CASES.map((candidate) => candidate.batch),
      rows: CASES.map((candidate) => candidate.rows),
      inner: CASES.map((candidate) => candidate.inner),
      columns: CASES.map((candidate) => candidate.columns),
      rowTile: ROW_TILE,
      columnBlock: COLUMN_BLOCK,
      innerLoop: "unroll4",
      rightLayout: "packed-panels",
    },
    bytes: Math.max(
      ...CASES.map((candidate) =>
        (
          candidate.batch * candidate.rows * candidate.inner +
          candidate.inner * candidate.columns +
          2 * candidate.batch * candidate.rows * candidate.columns
        ) * 4
      ),
    ),
  },
  correctness: {
    passed: true,
    checks: CASES.length * 3,
    summary: "flattened shared-B batches match repeated independent GEMM calls",
  },
  measurements,
  metrics,
  notes: [
    "Each logical batch has an independent contiguous A and C matrix and shares one resident packed B.",
    "The flattened path specializes rows=batch*rows and therefore executes one Wasm call.",
    "NC blocking in the flattened path traverses all batch rows before moving to the next B column block.",
    "Packing and allocation are excluded; all four variants operate on the same resident data.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_BATCH_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_BATCH_SUMMARY") === "1") console.log(JSON.stringify(metrics));
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
