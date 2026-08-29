import { detectHostCpu } from "@mizchi/jsimd-bench/browser-runner";
import { measureResident } from "@mizchi/jsimd-bench/measure";
import { createBenchmarkResult, detectBenchmarkEnvironment } from "@mizchi/jsimd-bench/result";
import { add, compileF32Map, constant, input, multiply, relu } from "./mod.ts";

const ROWS = Number(Deno.env.get("JSIMD_FUSION_ROWS") ?? 1_048_579);
const WARMUPS = Number(Deno.env.get("JSIMD_FUSION_WARMUPS") ?? 10);
const SAMPLES = Number(Deno.env.get("JSIMD_FUSION_SAMPLES") ?? 31);
const OPERATIONS = Number(Deno.env.get("JSIMD_FUSION_OPERATIONS") ?? 1);
const timing = { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: OPERATIONS };
const alpha = 1.5;
const beta = -0.5;
const bias = 2;

const bytesPerArray = align16(ROWS * Float32Array.BYTES_PER_ELEMENT);
const aPointer = 0;
const bPointer = bytesPerArray;
const outputPointer = bytesPerArray * 2;
const temporary0Pointer = bytesPerArray * 3;
const temporary1Pointer = bytesPerArray * 4;
const memoryBytes = bytesPerArray * 5;
const memory = new WebAssembly.Memory({ initial: Math.ceil(memoryBytes / 65_536) });
const a = new Float32Array(memory.buffer, aPointer, ROWS);
const b = new Float32Array(memory.buffer, bPointer, ROWS);
const output = new Float32Array(memory.buffer, outputPointer, ROWS);
for (let index = 0; index < ROWS; index++) {
  a[index] = (index % 257) * 0.03125 - 4;
  b[index] = (index % 131) * 0.0625 - 3;
}

const linear = add(multiply(constant(alpha), input(0)), multiply(constant(beta), input(1)));
const fusedExpression = relu(add(linear, constant(bias)));
const compileStarted = performance.now();
const fusedCompiled = await compileF32Map(fusedExpression, 2);
const compileMs = performance.now() - compileStarted;
const instantiateStarted = performance.now();
const fused = await fusedCompiled.instantiate(memory);
const instantiateMs = performance.now() - instantiateStarted;
const firstRunStarted = performance.now();
fused.run(aPointer, bPointer, outputPointer, ROWS);
const firstRunMs = performance.now() - firstRunStarted;

const linearCompiled = await compileF32Map(linear, 2);
const biasCompiled = await compileF32Map(add(input(0), constant(bias)), 1);
const reluCompiled = await compileF32Map(relu(input(0)), 1);
const [linearKernel, biasKernel, reluKernel] = await Promise.all([
  linearCompiled.instantiate(memory),
  biasCompiled.instantiate(memory),
  reluCompiled.instantiate(memory),
]);

const expected = new Float32Array(ROWS);
javascriptFused(a, b, expected);
assertClose(output, expected);
linearKernel.run(aPointer, bPointer, temporary0Pointer, ROWS);
biasKernel.run(temporary0Pointer, temporary1Pointer, ROWS);
reluKernel.run(temporary1Pointer, outputPointer, ROWS);
assertClose(output, expected);

let sink = 0;
const javascript = await measureResident("js/fused-single-loop", timing, () => {
  javascriptFused(a, b, output);
  sink += output[ROWS - 1]!;
});
const wasmSplit = await measureResident("wasm/generated-three-pass", timing, () => {
  linearKernel.run(aPointer, bPointer, temporary0Pointer, ROWS);
  biasKernel.run(temporary0Pointer, temporary1Pointer, ROWS);
  reluKernel.run(temporary1Pointer, outputPointer, ROWS);
  sink += output[ROWS - 1]!;
});
const wasmFused = await measureResident("wasm/generated-fused-resident", timing, () => {
  fused.run(aPointer, bPointer, outputPointer, ROWS);
  sink += output[ROWS - 1]!;
});

const savedPerCallMs = javascript.medianMs - wasmFused.medianMs;
const constructionMs = compileMs + instantiateMs;
const breakEvenCalls = savedPerCallMs > 0 ? Math.ceil(constructionMs / savedPerCallMs) : null;
const result = createBenchmarkResult({
  name: "dynamic-wasm-fusion/f32-map",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({
    logicalCpus: navigator.hardwareConcurrency,
    cpu: await detectHostCpu(),
    adapter: null,
  }),
  timing,
  input: {
    shape: { rows: ROWS, inputs: 2, expressionNodes: 11 },
    bytes: ROWS * Float32Array.BYTES_PER_ELEMENT * 3,
  },
  correctness: {
    passed: true,
    checks: 2,
    summary: "generated fused and generated three-pass kernels match the JavaScript result",
  },
  measurements: [javascript, wasmSplit, wasmFused],
  metrics: {
    fused_speedup_vs_js: round(javascript.medianMs / wasmFused.medianMs),
    fusion_speedup_vs_three_pass: round(wasmSplit.medianMs / wasmFused.medianMs),
    generated_wasm_bytes: fusedCompiled.bytes.byteLength,
    compile_ms: round(compileMs, 4),
    instantiate_ms: round(instantiateMs, 4),
    first_run_ms: round(firstRunMs, 4),
    break_even_calls_vs_js: breakEvenCalls,
    sink: round(sink, 3),
  },
  notes: [
    "The generated module is emitted directly as a Wasm binary; WAT and Binaryen are not used at runtime.",
    "Resident measurements exclude expression construction, module compilation, and instantiation.",
    "JavaScript and Wasm operate on the same WebAssembly.Memory-backed Float32Array values.",
    "The three-pass path materializes two full temporary arrays and crosses the JS/Wasm boundary three times.",
    "The fused path reads two arrays and writes one array in a single pass.",
    "compile_ms is a cold-process sample; engine caches and tiering can change repeated construction costs.",
  ],
});

const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_FUSION_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
if (Deno.env.get("JSIMD_FUSION_SUMMARY") === "1") console.log(JSON.stringify(result.metrics));
else console.log(json);

function javascriptFused(left: Float32Array, right: Float32Array, target: Float32Array): void {
  for (let index = 0; index < left.length; index++) {
    target[index] = Math.max(0, alpha * left[index]! + beta * right[index]! + bias);
  }
}

function assertClose(actual: Float32Array, expected: Float32Array): void {
  for (let index = 0; index < actual.length; index++) {
    if (Math.abs(actual[index]! - expected[index]!) <= 1e-5) continue;
    throw new Error(
      `result mismatch at ${index}: expected ${expected[index]}, got ${actual[index]}`,
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
