import { createPixelBlockGpuPlan } from "./pixel_block_gpu_plan.ts";
import { createPixelBlockPlan } from "./pixel_block_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("WebGPU block dispatch owns exactly the scalar staggered partition", () => {
  for (const [width, height] of [[1, 1], [7, 5], [16, 10], [1_024, 640]] as const) {
    for (let tick = 0; tick < 2; tick++) {
      const scalar = createPixelBlockPlan(width, height, tick);
      const gpu = createPixelBlockGpuPlan(width, height, tick);
      assertEquals(gpu.origin, scalar.origin);
      assertEquals(gpu.blockColumns, scalar.blockColumns);
      assertEquals(gpu.blockRows, scalar.blockRows);
      assertEquals(gpu.blockCount, scalar.blockCount);
      assertEquals(gpu.workgroups, Math.ceil(scalar.blockCount / 64));
    }
  }
});
