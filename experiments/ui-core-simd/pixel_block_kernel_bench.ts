import { detectHostCpu } from "../../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../../packages/bench/src/measure.ts";
import {
  createBenchmarkResult,
  detectBenchmarkEnvironment,
} from "../../packages/bench/src/result.ts";
import { WasmSimdPixelBlock } from "./pixel_block_kernel.ts";
import { stepPixelWorldBlock } from "./pixel_block_sim.ts";
import { createPixelScenario } from "./pixel_sim.ts";

const WARMUPS = 20;
const SAMPLES = 100;
const STEPS_PER_SAMPLE = 4;
const SNAPSHOT_TICK = 20;
const SEED = 0x51f1_5e5d;
const widths = [256, 512, 1_024] as const;
const measurements = [];
let sink = 0;

for (const width of widths) {
  const height = width * 5 / 8;
  const initial = createPixelScenario(width, height, 0.25, SEED, "full");
  const snapshot = initial.slice();
  for (let tick = 0; tick < SNAPSHOT_TICK; tick++) {
    stepPixelWorldBlock(snapshot, width, height, tick, SEED);
  }
  const jsCells = snapshot.slice();
  const wasmSimd = await WasmSimdPixelBlock.create(width, height);
  wasmSimd.set(snapshot);
  const backends = [
    {
      name: "js-scalar",
      reset: () => jsCells.set(snapshot),
      step: (tick: number) => {
        sink ^= stepPixelWorldBlock(jsCells, width, height, tick, SEED).moves;
      },
    },
    {
      name: "wasm-simd-row-major",
      reset: () => wasmSimd.set(snapshot),
      step: (tick: number) => sink ^= wasmSimd.step(tick, SEED),
    },
  ] as const;

  for (let warmup = 0; warmup < WARMUPS; warmup++) {
    for (const backend of backends) {
      backend.reset();
      for (let step = 0; step < STEPS_PER_SAMPLE; step++) {
        backend.step(SNAPSHOT_TICK + step);
      }
    }
  }
  const samples = new Map(backends.map((backend) => [backend.name, [] as number[]]));
  for (let sample = 0; sample < SAMPLES; sample++) {
    for (let offset = 0; offset < backends.length; offset++) {
      const backend = backends[(sample + offset) % backends.length]!;
      backend.reset();
      const started = performance.now();
      for (let step = 0; step < STEPS_PER_SAMPLE; step++) {
        backend.step(SNAPSHOT_TICK + step);
      }
      samples.get(backend.name)!.push((performance.now() - started) / STEPS_PER_SAMPLE);
    }
  }
  assertCellsEqual(wasmSimd.cells, jsCells, `${width} Wasm SIMD`);
  for (const backend of backends) {
    measurements.push(summarizeBenchmarkSamples(
      `${backend.name}/width=${width}/cells=${width * height}/step`,
      "resident",
      samples.get(backend.name)!,
    ));
  }
}

const rawWasmBytes = (await Deno.stat(
  new URL("./pixel_block_step.wasm", import.meta.url),
)).size;
const result = createBenchmarkResult({
  name: "ui-core-simd/pixel-block-row-major",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({ cpu: await detectHostCpu() }),
  timing: {
    warmups: WARMUPS,
    samples: SAMPLES,
    operationsPerSample: STEPS_PER_SAMPLE,
  },
  input: {
    shape: {
      widths,
      occupancyPercent: 25,
      region: "full",
      seed: SEED,
      snapshotTick: SNAPSHOT_TICK,
    },
    bytes: 1_024 * 640 * 4,
  },
  correctness: {
    passed: true,
    checks: widths.length,
    summary: "Row-major SIMD worlds exactly matched the JS oracle after the final measured run.",
  },
  measurements,
  metrics: { rawWasmBytes, sink: sink >>> 0 },
  notes: [
    "All backends retain row-major u32 state; construction and per-sample snapshot restoration are excluded.",
    "Each sample restores the same tick-20 snapshot outside the timer, then measures ticks 20 through 23.",
    "The SIMD loop evaluates density, diagonal, and lateral rules for four adjacent 2x2 blocks per vector; only the zero-to-three row-tail blocks remain scalar inside Wasm.",
    "Backend order rotates per sample to reduce ordering and thermal bias.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_BLOCK_SIMD_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
console.log(json);

function assertCellsEqual(actual: Uint32Array, expected: Uint32Array, label: string): void {
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${label}: cell ${index}, expected ${expected[index]}, got ${actual[index]}`,
      );
    }
  }
}
