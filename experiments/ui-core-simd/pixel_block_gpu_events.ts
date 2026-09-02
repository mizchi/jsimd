import { createPixelBlockPlan } from "./pixel_block_sim.ts";
import {
  decodePixelGpuEvents,
  PIXEL_GPU_EVENT_HEADER_WORDS,
  PIXEL_GPU_EVENT_RECORD_WORDS,
  type PixelGpuEventBatch,
  pixelGpuEventBytes,
} from "./pixel_gpu_event_buffer.ts";

export const PIXEL_BLOCK_GPU_EVENT_HEADER_WORDS = PIXEL_GPU_EVENT_HEADER_WORDS;
export const PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS = PIXEL_GPU_EVENT_RECORD_WORDS;
export const PIXEL_BLOCK_GPU_EVENT_KIND = { changed: 1 } as const;

export type PixelBlockGpuEventBatch = PixelGpuEventBatch;

export function pixelBlockGpuEventBytes(capacity: number): number {
  return pixelGpuEventBytes(capacity);
}

/** Scalar oracle for one event per owned 2x2 block whose complete cells changed. */
export function collectPixelBlockChangedEvents(
  before: Uint32Array,
  after: Uint32Array,
  width: number,
  height: number,
  tick: number,
  capacity: number,
): PixelBlockGpuEventBatch {
  if (before.length !== width * height || after.length !== before.length) {
    throw new RangeError("event worlds must match dimensions");
  }
  validateCapacity(capacity);
  const plan = createPixelBlockPlan(width, height, tick);
  const records = new Uint32Array(
    Math.min(plan.blockCount, capacity) * PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS,
  );
  let total = 0;
  for (let blockY = 0; blockY < plan.blockRows; blockY++) {
    const y = plan.origin + blockY * 2;
    for (let blockX = 0; blockX < plan.blockColumns; blockX++) {
      const x = plan.origin + blockX * 2;
      const topLeft = y * width + x;
      const indices = [topLeft, topLeft + 1, topLeft + width, topLeft + width + 1];
      let changedMask = 0;
      for (let lane = 0; lane < indices.length; lane++) {
        const index = indices[lane]!;
        if (before[index] !== after[index]) changedMask |= 1 << lane;
      }
      if (changedMask === 0) continue;
      if (total < capacity) {
        const offset = total * PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS;
        records[offset] = PIXEL_BLOCK_GPU_EVENT_KIND.changed;
        records[offset + 1] = topLeft;
        records[offset + 2] = changedMask;
        records[offset + 3] = tick;
      }
      total++;
    }
  }
  return {
    total,
    dropped: Math.max(0, total - capacity),
    tick,
    records: records.slice(0, Math.min(total, capacity) * PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS),
  };
}

export function decodePixelBlockGpuEvents(
  words: Uint32Array,
  capacity: number,
): PixelBlockGpuEventBatch {
  return decodePixelGpuEvents(words, capacity);
}

function validateCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_048_576) {
    throw new RangeError("GPU event capacity must be between 1 and 1048576");
  }
}
