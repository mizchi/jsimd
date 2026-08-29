import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { type BenchmarkMeasurement, measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { SimdMatrix2D } from "@mizchi/jsimd/matrix2d";
import { add, compileF32Gemm, compileF32Map, constant, input, multiply, relu } from "./mod.ts";

const SIZES = (Deno.env.get("JSIMD_FUSION_GEMM_SIZES") ?? "16,64,128,256")
  .split(",")
  .map(Number);
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_GEMM_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_GEMM_SAMPLES") ?? 21);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_GEMM_OPERATIONS") ?? 8);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const alpha = 1.25;
const measurements: BenchmarkMeasurement[] = [];
const metrics: Record<string, number> = {};
let sink = 0;

for (const size of SIZES) {
  if (!Number.isInteger(size) || size < 1 || size % 4 !== 0) {
    throw new RangeError("GEMM benchmark sizes must be positive multiples of four");
  }
  const elements = size * size;
  const aValues = Float32Array.from(
    { length: elements },
    (_, index) => ((index * 17 + 3) % 101 - 50) / 32,
  );
  const bValues = Float32Array.from(
    { length: elements },
    (_, index) => ((index * 29 + 7) % 97 - 48) / 32,
  );
  const biasValues = Float32Array.from(
    { length: size },
    (_, index) => (index % 11 - 5) / 16,
  );
  const arrayBytes = align16(elements * 4);
  const aPointer = 0;
  const bPointer = arrayBytes;
  const outputPointer = arrayBytes * 2;
  const temporaryPointer = arrayBytes * 3;
  const biasPointer = arrayBytes * 4;
  const memoryBytes = biasPointer + arrayBytes;
  const memory = new WebAssembly.Memory({ initial: Math.max(1, Math.ceil(memoryBytes / 65_536)) });
  const a = new Float32Array(memory.buffer, aPointer, elements);
  const b = new Float32Array(memory.buffer, bPointer, elements);
  const output = new Float32Array(memory.buffer, outputPointer, elements);
  const temporary = new Float32Array(memory.buffer, temporaryPointer, elements);
  const biasMatrix = new Float32Array(memory.buffer, biasPointer, elements);
  a.set(aValues);
  b.set(bValues);
  for (let row = 0; row < size; row++) biasMatrix.set(biasValues, row * size);

  const compileStarted = performance.now();
  const fusedCompiled = await compileF32Gemm({
    rows: size,
    inner: size,
    columns: size,
    alpha,
    bias: { kind: "columns" },
    activation: { kind: "relu" },
  });
  const compileMs = performance.now() - compileStarted;
  const pureCompiled = await compileF32Gemm({ rows: size, inner: size, columns: size });
  const epilogueCompiled = await compileF32Map(
    relu(add(multiply(constant(alpha), input(0)), input(1))),
    2,
  );
  const instantiateStarted = performance.now();
  const fused = await fusedCompiled.instantiate(memory);
  const instantiateMs = performance.now() - instantiateStarted;
  const [pure, epilogue] = await Promise.all([
    pureCompiled.instantiate(memory),
    epilogueCompiled.instantiate(memory),
  ]);

  using staticA = SimdMatrix2D.from(size, size, aValues);
  using staticB = SimdMatrix2D.from(size, size, bValues);
  using staticOutput = new SimdMatrix2D(size, size);

  javascriptGemm(a, b, output, biasValues, size);
  const expected = new Float32Array(output);
  fused.run(aPointer, bPointer, outputPointer, biasPointer);
  assertClose(output, expected, `fused ${size}`);
  pure.run(aPointer, bPointer, temporaryPointer, 0);
  epilogue.run(temporaryPointer, biasPointer, outputPointer, elements);
  assertClose(output, expected, `split ${size}`);

  // Force every JS and Wasm function past startup tiering before measuring any
  // path. Otherwise the later split path can inherit optimization triggered by
  // the earlier pure-GEMM measurement.
  for (let iteration = 0; iteration < 64; iteration++) {
    javascriptGemm(a, b, output, biasValues, size);
    staticA.multiplyInto(staticB, staticOutput);
    pure.run(aPointer, bPointer, temporaryPointer, 0);
    epilogue.run(temporaryPointer, biasPointer, outputPointer, elements);
    fused.run(aPointer, bPointer, outputPointer, biasPointer);
  }

  const javascript = await measureResident(`gemm/${size}/js-block4-fused`, timing, () => {
    javascriptGemm(a, b, output, biasValues, size);
    sink += output[elements - 1]!;
  });
  const staticGeneric = await measureResident(`gemm/${size}/static-generic-matmul`, timing, () => {
    staticA.multiplyInto(staticB, staticOutput);
    sink += staticOutput.get(size - 1, size - 1);
  });
  const generatedPure = await measureResident(`gemm/${size}/generated-matmul`, timing, () => {
    pure.run(aPointer, bPointer, temporaryPointer, 0);
    sink += temporary[elements - 1]!;
  });
  const generatedSplit = await measureResident(
    `gemm/${size}/generated-split-epilogue`,
    timing,
    () => {
      pure.run(aPointer, bPointer, temporaryPointer, 0);
      epilogue.run(temporaryPointer, biasPointer, outputPointer, elements);
      sink += output[elements - 1]!;
    },
  );
  const generatedFused = await measureResident(`gemm/${size}/generated-fused`, timing, () => {
    fused.run(aPointer, bPointer, outputPointer, biasPointer);
    sink += output[elements - 1]!;
  });
  measurements.push(javascript, staticGeneric, generatedPure, generatedSplit, generatedFused);
  metrics[`gemm_${size}_speedup_vs_js`] = round(javascript.medianMs / generatedFused.medianMs);
  metrics[`gemm_${size}_speedup_vs_static_generic`] = round(
    staticGeneric.medianMs / generatedFused.medianMs,
  );
  metrics[`gemm_${size}_fusion_speedup`] = round(generatedSplit.medianMs / generatedFused.medianMs);
  metrics[`gemm_${size}_generated_bytes`] = fusedCompiled.bytes.byteLength;
  metrics[`gemm_${size}_compile_ms`] = round(compileMs, 4);
  metrics[`gemm_${size}_instantiate_ms`] = round(instantiateMs, 4);
  const savedPerCallMs = javascript.medianMs - generatedFused.medianMs;
  metrics[`gemm_${size}_break_even_calls_vs_js`] = savedPerCallMs > 0
    ? Math.ceil((compileMs + instantiateMs) / savedPerCallMs)
    : -1;
}

metrics.sink = round(Math.abs(sink), 3);
const largest = Math.max(...SIZES);
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/gemm",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: { squareSizes: SIZES, alpha, beta: 0, bias: "columns", activation: "relu" },
    bytes: largest * largest * 4 * 3,
  },
  correctness: {
    passed: true,
    checks: SIZES.length * 2,
    summary: "generated fused and split GEMM paths match a four-column JavaScript reference",
  },
  measurements,
  metrics,
  notes: [
    "All timing is resident and excludes plan generation, compilation, instantiation, and input copies.",
    "The fused workload computes relu(alpha*A*B + per-column bias) with beta zero.",
    "The static generic Matrix2D row measures only A*B and is therefore a lower-work baseline, not feature-equivalent.",
    "The split generated path materializes A*B and performs alpha, repeated column bias, and ReLU in a second SIMD pass.",
    "The JavaScript reference evaluates four adjacent output columns per inner-loop iteration.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_GEMM_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_GEMM_SUMMARY") === "1") console.log(JSON.stringify(metrics));
else console.log(json);

function javascriptGemm(
  a: Float32Array,
  b: Float32Array,
  output: Float32Array,
  bias: Float32Array,
  size: number,
): void {
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column += 4) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let inner = 0; inner < size; inner++) {
        const left = a[row * size + inner]!;
        const rightOffset = inner * size + column;
        a0 += left * b[rightOffset]!;
        a1 += left * b[rightOffset + 1]!;
        a2 += left * b[rightOffset + 2]!;
        a3 += left * b[rightOffset + 3]!;
      }
      const outputOffset = row * size + column;
      output[outputOffset] = Math.max(0, alpha * a0 + bias[column]!);
      output[outputOffset + 1] = Math.max(0, alpha * a1 + bias[column + 1]!);
      output[outputOffset + 2] = Math.max(0, alpha * a2 + bias[column + 2]!);
      output[outputOffset + 3] = Math.max(0, alpha * a3 + bias[column + 3]!);
    }
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
