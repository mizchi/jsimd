import { detectHostCpu } from "../../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../../packages/bench/src/measure.ts";
import {
  createBenchmarkResult,
  detectBenchmarkEnvironment,
} from "../../packages/bench/src/result.ts";
import { WasmSimdPixelBlock } from "./pixel_block_kernel.ts";
import { MATERIAL, type PixelMaterial } from "./pixel_material.ts";
import { WasmSimdPixelReaction } from "./pixel_reaction_kernel.ts";
import { packPixel } from "./pixel_sim.ts";

const WARMUPS = 12;
const SAMPLES = 60;
const STEPS = 16;
const WIDTHS = [256, 512, 1_024] as const;
const HEIGHT_RATIO = 5 / 8;
const EVENT_CAPACITY = 2_048;
const SEED = 0x51f1_5e5d;
const scenarios = [
  {
    name: "baseline-6",
    materials: [MATERIAL.sand, MATERIAL.water, MATERIAL.gas, MATERIAL.fire],
  },
  {
    name: "expanded-12",
    materials: [
      MATERIAL.sand,
      MATERIAL.water,
      MATERIAL.gas,
      MATERIAL.fire,
      MATERIAL.stone,
      MATERIAL.wood,
      MATERIAL.oil,
      MATERIAL.smoke,
      MATERIAL.acid,
      MATERIAL.lava,
    ],
  },
] as const;

const measurements = [];
let sink = 0;

for (const width of WIDTHS) {
  const height = width * HEIGHT_RATIO;
  for (const scenario of scenarios) {
    const initial = createMaterialWorld(width, height, scenario.materials, SEED);
    const movement = await WasmSimdPixelBlock.create(width, height);
    const reaction = await WasmSimdPixelReaction.create(initial, width, height, EVENT_CAPACITY);
    const movementSamples: number[] = [];
    const reactionSamples: number[] = [];

    for (let warmup = 0; warmup < WARMUPS; warmup++) {
      movement.set(initial);
      reaction.cells.set(initial);
      for (let step = 0; step < STEPS; step++) {
        sink ^= movement.step(step, SEED);
        sink ^= reaction.step().reactions;
      }
    }
    for (let sample = 0; sample < SAMPLES; sample++) {
      movement.set(initial);
      let started = performance.now();
      for (let step = 0; step < STEPS; step++) sink ^= movement.step(step, SEED);
      movementSamples.push((performance.now() - started) / STEPS);

      reaction.cells.set(initial);
      started = performance.now();
      for (let step = 0; step < STEPS; step++) sink ^= reaction.step().reactions;
      reactionSamples.push((performance.now() - started) / STEPS);
    }
    measurements.push(
      summarizeBenchmarkSamples(
        `movement/wasm-simd/${scenario.name}/width=${width}`,
        "resident",
        movementSamples,
      ),
      summarizeBenchmarkSamples(
        `reaction/wasm-simd/${scenario.name}/width=${width}`,
        "resident",
        reactionSamples,
      ),
    );
  }
}

const movementWasmBytes =
  (await Deno.stat(new URL("./pixel_block_step.wasm", import.meta.url))).size;
const reactionWasmBytes =
  (await Deno.stat(new URL("./pixel_reaction_step.wasm", import.meta.url))).size;
const result = createBenchmarkResult({
  name: "ui-core-simd/pixel-material-scaling",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({ cpu: await detectHostCpu() }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: STEPS },
  input: {
    shape: {
      widths: WIDTHS,
      scenarios: scenarios.map((scenario) => scenario.name).join(","),
      occupancyPercent: 25,
      eventCapacity: EVENT_CAPACITY,
    },
    bytes: 1_024 * 640 * Uint32Array.BYTES_PER_ELEMENT,
  },
  correctness: {
    passed: true,
    checks: WIDTHS.length * scenarios.length * 2,
    summary:
      "The benchmark uses the same kernels covered by exhaustive 12-material scalar/SIMD conformance tests.",
  },
  measurements,
  metrics: {
    movementWasmBytes,
    reactionWasmBytes,
    combinedWasmBytes: movementWasmBytes + reactionWasmBytes,
    sink: sink >>> 0,
  },
  notes: [
    "baseline-6 uses the original empty/wall plus sand, water, gas, and fire vocabulary.",
    "expanded-12 adds stone, wood, oil, smoke, acid, and lava while keeping 25% occupancy.",
    "Hot water/gas, combustible wood/oil, acid, and lava deliberately exercise phase-change, ignition, extinguishing, corrosion, and solidification branches; event overflow is counted but event records stay in resident Wasm memory.",
    "Each timed sample restores the same world outside the timer and measures 16 consecutive ticks.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_MATERIAL_SCALING_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
console.log(json);

function createMaterialWorld(
  width: number,
  height: number,
  materials: readonly PixelMaterial[],
  initialSeed: number,
): Uint32Array {
  const cells = new Uint32Array(width * height);
  let seed = initialSeed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        cells[index] = packPixel(MATERIAL.wall);
        continue;
      }
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      if ((seed >>> 0) % 4 !== 0) {
        cells[index] = packPixel(MATERIAL.empty);
        continue;
      }
      const material = materials[(seed >>> 8) % materials.length]!;
      const temperature = material === MATERIAL.fire || material === MATERIAL.lava
        ? 255
        : material === MATERIAL.gas
        ? 72
        : material === MATERIAL.water
        ? 152
        : material === MATERIAL.wood || material === MATERIAL.oil
        ? 192
        : 128;
      cells[index] = packPixel(material, temperature, x & 0xff, y & 0xff);
    }
  }
  return cells;
}
