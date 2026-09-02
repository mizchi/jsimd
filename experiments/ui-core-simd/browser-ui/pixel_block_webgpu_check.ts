import { stepPixelWorldBlock } from "../pixel_block_sim.ts";
import { createPixelScenario, MATERIAL } from "../pixel_sim.ts";
import { WebGpuBlockPixelSimulation } from "./pixel_block_webgpu.ts";

export interface PixelBlockWebGpuCheckResult {
  readonly width: number;
  readonly height: number;
  readonly ticks: number;
  readonly mismatches: number;
  readonly firstMismatch: number;
  readonly expected: number;
  readonly actual: number;
}

/** Browser-only, explicit-readback conformance check. Not imported by the demo runtime. */
export async function checkPixelBlockWebGpu(): Promise<PixelBlockWebGpuCheckResult> {
  const width = 63;
  const height = 41;
  const ticks = 48;
  const initial = createPixelScenario(width, height, 0.37, 0x6a09_e667, "full");
  seedExtraMaterials(initial, width, height);
  const expected = initial.slice();
  for (let tick = 0; tick < ticks; tick++) stepPixelWorldBlock(expected, width, height, tick);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.hidden = true;
  document.body.append(canvas);
  const simulation = await WebGpuBlockPixelSimulation.create(canvas, initial, width, height);
  try {
    for (let tick = 0; tick < ticks; tick++) await simulation.step(tick);
    const actual = await simulation.readCells();
    let mismatches = 0;
    let firstMismatch = -1;
    for (let index = 0; index < expected.length; index++) {
      if (expected[index] === actual[index]) continue;
      mismatches++;
      if (firstMismatch === -1) firstMismatch = index;
    }
    return {
      width,
      height,
      ticks,
      mismatches,
      firstMismatch,
      expected: firstMismatch === -1 ? 0 : expected[firstMismatch]!,
      actual: firstMismatch === -1 ? 0 : actual[firstMismatch]!,
    };
  } finally {
    await simulation[Symbol.asyncDispose]();
    canvas.remove();
  }
}

function seedExtraMaterials(cells: Uint32Array, width: number, height: number): void {
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const index = y * width + x;
      if (index % 97 === 0) cells[index] = MATERIAL.gas | ((index & 0xff) << 8);
      if (index % 211 === 0) cells[index] = MATERIAL.fire | ((index & 0xff) << 8);
    }
  }
}
