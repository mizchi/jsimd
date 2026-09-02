import { createPixelBlockPlan } from "./pixel_block_sim.ts";

export const PIXEL_BLOCK_GPU_WORKGROUP_SIZE = 64;

export interface PixelBlockGpuPlan {
  readonly origin: 0 | 1;
  readonly blockColumns: number;
  readonly blockRows: number;
  readonly blockCount: number;
  readonly workgroups: number;
}

export function createPixelBlockGpuPlan(
  width: number,
  height: number,
  tick: number,
): PixelBlockGpuPlan {
  const plan = createPixelBlockPlan(width, height, tick);
  return {
    ...plan,
    workgroups: Math.ceil(plan.blockCount / PIXEL_BLOCK_GPU_WORKGROUP_SIZE),
  };
}
