import { createPixelGearKernel } from "./kernel.ts";
import { createPixelScenario, stepPixelWorld } from "../ui-core-simd/pixel_sim.ts";

const width = 256;
const height = 160;
const source = createPixelScenario(width, height, 0.24, 0x6e61_7267, "quarter");
const wasmBytes = await Deno.readFile(new URL("./zig/kernel.wasm", import.meta.url));
const kernel = await createPixelGearKernel({ wasmBytes });
const zigCells = kernel.createWorld(source);
const typescriptCells = source.slice();
let zigPhase = 0;
let typescriptPhase = 0;

Deno.bench({
  name: "TypeScript pixel world step",
  group: "pixel-world-step",
  baseline: true,
  fn() {
    stepPixelWorld(typescriptCells, width, height, typescriptPhase++);
  },
});

Deno.bench({
  name: "Zig SIMD Wasm pixel world step",
  group: "pixel-world-step",
  fn() {
    kernel.stepWorld(zigCells, width, height, zigPhase++);
  },
});
