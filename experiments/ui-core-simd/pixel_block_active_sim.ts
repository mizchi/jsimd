import { DEFAULT_PIXEL_BLOCK_SEED, stepPixelBlockRangeUnchecked } from "./pixel_block_sim.ts";
import { PixelChunkActivity } from "./pixel_chunk_activity.ts";

export interface PixelBlockActiveStepResult {
  readonly moves: number;
  readonly blocks: number;
  readonly activeChunks: number;
}

/** Advances only blocks owned by active chunks while preserving full-scan block semantics. */
export function stepPixelWorldBlockActive(
  cells: Uint32Array,
  width: number,
  height: number,
  tick: number,
  activity: PixelChunkActivity,
  seed = DEFAULT_PIXEL_BLOCK_SEED,
): PixelBlockActiveStepResult {
  validateWorld(cells, width, height);
  if (activity.width !== width || activity.height !== height) {
    throw new RangeError("pixel chunk activity does not match the world");
  }
  nonNegativeSafeInteger(tick, "tick");
  uint32(seed, "seed");
  const activeChunks = activity.activeChunkCount;
  let moves = 0;
  let blocks = 0;
  activity.beginStep();
  activity.forEachActiveChunk((bounds) => {
    const result = stepPixelBlockRangeUnchecked(
      cells,
      width,
      height,
      tick,
      seed,
      bounds.left,
      bounds.top,
      bounds.right,
      bounds.bottom,
      (first, second) => activity.markMoved(first, second),
    );
    moves += result.moves;
    blocks += result.blocks;
  });
  activity.finishStep();
  return { moves, blocks, activeChunks };
}

function validateWorld(cells: Uint32Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("pixel world dimensions must be positive safe integers");
  }
  if (cells.length !== width * height) {
    throw new RangeError(`pixel world must contain ${width * height} cells`);
  }
}

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function uint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}
