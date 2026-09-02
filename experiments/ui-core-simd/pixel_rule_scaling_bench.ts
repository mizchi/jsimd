import { detectHostCpu } from "../../packages/bench/src/browser_runner.ts";
import { summarizeBenchmarkSamples } from "../../packages/bench/src/measure.ts";
import {
  createBenchmarkResult,
  detectBenchmarkEnvironment,
} from "../../packages/bench/src/result.ts";
import { WasmPixelMaterialDispatch } from "./pixel_material_dispatch.ts";
import { WasmSimdPixelReaction } from "./pixel_reaction_kernel.ts";
import { planPixelRuleBuffers } from "./pixel_rule_scaling.ts";
import { createPixelScenario } from "./pixel_sim.ts";

const WARMUPS = 20;
const SAMPLES = 50;
const DENSE_REPETITIONS = 5;
const WIDTHS = [512, 1_024] as const;
const MATERIAL_COUNTS = [4, 8, 16, 32, 64, 128, 256] as const;
const DENSE_PASSES = [1, 2, 4, 8] as const;
const EVENT_CAPACITY = 256;
const measurements = [];
let sink = 0;

for (const width of WIDTHS) {
  const height = width * 5 / 8;
  const cellCount = width * height;
  const dispatch = await WasmPixelMaterialDispatch.create(cellCount);
  for (const materialCount of MATERIAL_COUNTS) {
    for (let index = 0; index < cellCount; index++) {
      dispatch.cells[index] = (index * 29 % materialCount) | 128 << 8;
    }
    const tableExpected = dispatch.tableChecksum();
    const specializedExpected = dispatch.specializedSimdChecksum(materialCount);
    if (tableExpected !== specializedExpected) {
      throw new Error("material dispatch checksum mismatch");
    }
    const backends = [
      { name: "table-scalar", run: () => dispatch.tableChecksum() },
      {
        name: "specialized-simd-masks",
        run: () => dispatch.specializedSimdChecksum(materialCount),
      },
    ] as const;
    const repetitions = materialCount <= 16
      ? 20
      : materialCount <= 64
      ? 10
      : materialCount <= 128
      ? 5
      : 3;
    for (let warmup = 0; warmup < WARMUPS; warmup++) {
      for (const backend of backends) sink ^= backend.run();
    }
    const samples = new Map(backends.map((backend) => [backend.name, [] as number[]]));
    for (let sample = 0; sample < SAMPLES; sample++) {
      for (let offset = 0; offset < backends.length; offset++) {
        const backend = backends[(sample + offset) % backends.length]!;
        const started = performance.now();
        for (let repetition = 0; repetition < repetitions; repetition++) sink ^= backend.run();
        samples.get(backend.name)!.push((performance.now() - started) / repetitions);
      }
    }
    for (const backend of backends) {
      measurements.push(summarizeBenchmarkSamples(
        `material-dispatch/${backend.name}/width=${width}/materials=${materialCount}`,
        "resident",
        samples.get(backend.name)!,
      ));
    }
  }

  const initial = createPixelScenario(width, height, 0.25, 0x51f1_5e5d, "full");
  const reaction = await WasmSimdPixelReaction.create(initial, width, height, EVENT_CAPACITY);
  for (const passCount of DENSE_PASSES) {
    for (let warmup = 0; warmup < WARMUPS; warmup++) {
      reaction.cells.set(initial);
      for (let pass = 0; pass < passCount; pass++) sink ^= reaction.step().reactions;
    }
    const samples = [] as number[];
    for (let sample = 0; sample < SAMPLES; sample++) {
      reaction.cells.set(initial);
      const started = performance.now();
      for (let repetition = 0; repetition < DENSE_REPETITIONS; repetition++) {
        for (let pass = 0; pass < passCount; pass++) sink ^= reaction.step().reactions;
      }
      samples.push((performance.now() - started) / DENSE_REPETITIONS);
    }
    measurements.push(summarizeBenchmarkSamples(
      `dense-rule-passes/wasm-simd/width=${width}/passes=${passCount}`,
      "resident",
      samples,
    ));
  }
}

const base512 = planPixelRuleBuffers({
  width: 512,
  height: 320,
  materialCount: 6,
  ruleCount: 2,
  eventCapacity: 256,
  fields: [],
});
const expanded512 = planPixelRuleBuffers({
  width: 512,
  height: 320,
  materialCount: 64,
  ruleCount: 32,
  eventCapacity: 2_048,
  fields: [
    { bytesPerCell: 1, buffers: 2 },
    { bytesPerCell: 2, buffers: 2 },
    { bytesPerCell: 1, buffers: 1 },
  ],
});
const expanded1024 = planPixelRuleBuffers({
  width: 1_024,
  height: 640,
  materialCount: 64,
  ruleCount: 32,
  eventCapacity: 2_048,
  fields: [
    { bytesPerCell: 1, buffers: 2 },
    { bytesPerCell: 2, buffers: 2 },
    { bytesPerCell: 1, buffers: 1 },
  ],
});

const result = createBenchmarkResult({
  name: "ui-core-simd/pixel-rule-scaling",
  recordedAt: new Date().toISOString(),
  environment: detectBenchmarkEnvironment({ cpu: await detectHostCpu() }),
  timing: { warmups: WARMUPS, samples: SAMPLES, operationsPerSample: 1 },
  input: {
    shape: {
      widths: WIDTHS,
      materialCounts: MATERIAL_COUNTS,
      densePasses: DENSE_PASSES,
      eventCapacity: EVENT_CAPACITY,
    },
    bytes: 1_024 * 640 * 4,
  },
  correctness: {
    passed: true,
    checks: WIDTHS.length * MATERIAL_COUNTS.length,
    summary: "Direct table and specialized SIMD-mask material dispatch produced equal checksums.",
  },
  measurements,
  metrics: {
    sink: sink >>> 0,
    "buffer.base512.totalOwnedBytes": base512.totalOwnedBytes,
    "buffer.expanded512.totalOwnedBytes": expanded512.totalOwnedBytes,
    "buffer.expanded512.fieldBytes": expanded512.fieldBytes,
    "buffer.expanded1024.totalOwnedBytes": expanded1024.totalOwnedBytes,
    "buffer.expanded1024.fieldBytes": expanded1024.fieldBytes,
    "buffer.material64Bytes": expanded512.materialTableBytes,
    "buffer.rules32Bytes": expanded512.ruleTableBytes,
    "buffer.eventCapacity2048ThreeCopiesBytes": expanded512.wasmEventBytes +
      expanded512.sharedEventBytes + expanded512.mainEventDrainBytes,
  },
  notes: [
    "Material dispatch is a synthetic decision benchmark: scalar direct-table lookup versus one SIMD equality mask per known material over four cells.",
    "Dense-pass scaling repeats the current temperature/reaction Wasm SIMD kernel and measures the unfused worst case for additional full-grid rules.",
    "The expanded buffer profile adds a double-buffered u8 field, a double-buffered u16 field, and one single-buffered u8 field; rules may share the existing u32 scratch.",
    "Explicit buffer totals exclude browser compositor, canvas backing-store, allocator, and Worker isolate overhead.",
  ],
});
const json = JSON.stringify(result, null, 2) + "\n";
const outputPath = Deno.env.get("JSIMD_PIXEL_RULE_SCALING_OUTPUT");
if (outputPath !== undefined) await Deno.writeTextFile(outputPath, json);
console.log(json);
