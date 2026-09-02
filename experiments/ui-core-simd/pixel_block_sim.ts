import { MATERIAL } from "./pixel_sim.ts";

export const DEFAULT_PIXEL_BLOCK_SEED = 0x51f1_5e5d;

export interface PixelBlockPlan {
  readonly origin: 0 | 1;
  readonly blockColumns: number;
  readonly blockRows: number;
  readonly blockCount: number;
}

export interface PixelBlockStepResult {
  readonly moves: number;
  readonly blocks: number;
}

export type PixelBlockHotCallback = (firstIndex: number, secondIndex: number) => void;

export function createPixelBlockPlan(
  width: number,
  height: number,
  tick: number,
): PixelBlockPlan {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  nonNegativeSafeInteger(tick, "tick");
  const origin = (tick & 1) as 0 | 1;
  const blockColumns = Math.max(0, Math.floor((width - origin) / 2));
  const blockRows = Math.max(0, Math.floor((height - origin) / 2));
  return {
    origin,
    blockColumns,
    blockRows,
    blockCount: blockColumns * blockRows,
  };
}

/**
 * Advances a conservative material world through one staggered 2x2 block partition.
 *
 * A block owns all four destinations for the duration of the step. Complete u32 cells are swapped,
 * and the moved mask prevents either source or destination from participating in a second swap.
 * Random choices depend only on the public seed, tick, and block coordinate.
 */
export function stepPixelWorldBlock(
  cells: Uint32Array,
  width: number,
  height: number,
  tick: number,
  seed = DEFAULT_PIXEL_BLOCK_SEED,
): PixelBlockStepResult {
  validateWorld(cells, width, height);
  nonNegativeSafeInteger(tick, "tick");
  uint32(seed, "seed");
  return stepPixelBlockRangeUnchecked(
    cells,
    width,
    height,
    tick,
    seed,
    0,
    0,
    width,
    height,
  );
}

/**
 * Runs blocks whose top-left cell belongs to the half-open range. Callers own validation.
 * The callback keeps sparse schedulers hot while a block contains dynamic material.
 */
export function stepPixelBlockRangeUnchecked(
  cells: Uint32Array,
  width: number,
  height: number,
  tick: number,
  seed: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  onHotBlock?: PixelBlockHotCallback,
): PixelBlockStepResult {
  const origin = tick & 1;
  let moves = 0;
  let blocks = 0;
  let hotNotified = false;
  for (let y = alignOrigin(top, origin); y < bottom && y + 1 < height; y += 2) {
    const blockY = (y - origin) >> 1;
    const topRow = y * width;
    const bottomRow = topRow + width;
    for (let x = alignOrigin(left, origin); x < right && x + 1 < width; x += 2) {
      const blockX = (x - origin) >> 1;
      blocks++;
      const topLeft = topRow + x;
      const topRight = topLeft + 1;
      const bottomLeft = bottomRow + x;
      const bottomRight = bottomLeft + 1;
      let a = cells[topLeft]!;
      let b = cells[topRight]!;
      let c = cells[bottomLeft]!;
      let d = cells[bottomRight]!;
      if (((a | b | c | d) & 0xfe) === 0) continue;
      if (!hotNotified && onHotBlock !== undefined) {
        onHotBlock(topLeft, bottomRight);
        hotNotified = true;
      }
      let moved = 0;

      if (shouldFall(a, c)) {
        const value = a;
        a = c;
        c = value;
        moved |= 0b0101;
        moves++;
      }
      if (shouldFall(b, d)) {
        const value = b;
        b = d;
        d = value;
        moved |= 0b1010;
        moves++;
      }

      if (moved === 0b1111) {
        cells[topLeft] = a;
        cells[topRight] = b;
        cells[bottomLeft] = c;
        cells[bottomRight] = d;
        continue;
      }

      const random = blockRandom(seed, tick, blockX, blockY);
      if ((random & 0b11) !== 0 && (moved & 0b1001) === 0 && shouldFall(a, d)) {
        const value = a;
        a = d;
        d = value;
        moved |= 0b1001;
        moves++;
      }
      if (
        (random >>> 2 & 0b11) !== 0 && (moved & 0b0110) === 0 && shouldFall(b, c)
      ) {
        const value = b;
        b = c;
        c = value;
        moved |= 0b0110;
        moves++;
      }

      if ((moved & 0b0011) === 0) {
        if ((random & 0x10) === 0 ? shouldFlowRight(a, b) : shouldFlowLeft(a, b)) {
          const value = a;
          a = b;
          b = value;
          moved |= 0b0011;
          moves++;
        }
      }
      if ((moved & 0b1100) === 0) {
        if ((random & 0x20) === 0 ? shouldFlowRight(c, d) : shouldFlowLeft(c, d)) {
          const value = c;
          c = d;
          d = value;
          moved |= 0b1100;
          moves++;
        }
      }

      cells[topLeft] = a;
      cells[topRight] = b;
      cells[bottomLeft] = c;
      cells[bottomRight] = d;
    }
  }
  return { moves, blocks };
}

function alignOrigin(value: number, origin: number): number {
  return (value & 1) === origin ? value : value + 1;
}

function shouldFall(top: number, bottom: number): boolean {
  const topMaterial = top & 0xff;
  const bottomMaterial = bottom & 0xff;
  if (topMaterial === MATERIAL.wall || bottomMaterial === MATERIAL.wall) return false;
  return density(topMaterial) > density(bottomMaterial);
}

function shouldFlowRight(left: number, right: number): boolean {
  return isFluid(left & 0xff) && (right & 0xff) === MATERIAL.empty;
}

function shouldFlowLeft(left: number, right: number): boolean {
  return (left & 0xff) === MATERIAL.empty && isFluid(right & 0xff);
}

function isFluid(material: number): boolean {
  return material === MATERIAL.water || material === MATERIAL.gas;
}

function density(material: number): number {
  if (material === MATERIAL.sand) return 2;
  if (material === MATERIAL.water) return 1;
  if (material === MATERIAL.gas) return -1;
  return 0;
}

function blockRandom(seed: number, tick: number, blockX: number, blockY: number): number {
  const coordinate = (Math.imul(blockY, 0x1_0001) + blockX + 1) >>> 0;
  let value = seed ^ Math.imul((tick + 1) >>> 0, 0x9e37_79b9) ^
    Math.imul(coordinate, 0x85eb_ca6b);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function validateWorld(cells: Uint32Array, width: number, height: number): void {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (cells.length !== width * height) {
    throw new RangeError(`pixel world must contain ${width * height} cells`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
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
