import { PixelChunkActivity } from "./pixel_chunk_activity.ts";

const MATERIAL_EMPTY = 0;
const MATERIAL_WALL = 1;
const MATERIAL_SAND = 2;
const MATERIAL_WATER = 3;

export interface PixelActiveStepResult {
  readonly moves: number;
  readonly activeChunks: number;
}

export function stepPixelWorldActive(
  cells: Uint32Array,
  width: number,
  height: number,
  phase: number,
  activity: PixelChunkActivity,
): PixelActiveStepResult {
  validateWorld(cells, width, height);
  if (activity.width !== width || activity.height !== height) {
    throw new RangeError("pixel chunk activity does not match the world");
  }
  if (!Number.isSafeInteger(phase) || phase < 0) {
    throw new RangeError("pixel simulation phase must be a non-negative safe integer");
  }
  const parity = phase & 1;
  const activeChunks = activity.activeChunkCount;
  activity.beginStep();
  let moves = activeVerticalPass(cells, width, height, parity, activity);
  moves += activeDiagonalPass(cells, width, height, parity, activity);
  moves += activeHorizontalWaterPass(cells, width, height, parity, activity);
  activity.finishStep();
  return { moves, activeChunks };
}

function activeVerticalPass(
  cells: Uint32Array,
  width: number,
  height: number,
  parity: number,
  activity: PixelChunkActivity,
): number {
  let moves = 0;
  activity.forEachActiveChunk((bounds) => {
    for (let y = alignParity(bounds.top, parity); y < bounds.bottom && y + 1 < height; y += 2) {
      const topRow = y * width;
      const bottomRow = topRow + width;
      for (let x = bounds.left; x < bounds.right; x++) {
        const top = topRow + x;
        const bottom = bottomRow + x;
        if (fallsThrough(cells[top]!, cells[bottom]!)) {
          swap(cells, top, bottom);
          activity.markMoved(top, bottom);
          moves++;
        }
      }
    }
  });
  return moves;
}

function activeDiagonalPass(
  cells: Uint32Array,
  width: number,
  height: number,
  parity: number,
  activity: PixelChunkActivity,
): number {
  let moves = 0;
  activity.forEachActiveChunk((bounds) => {
    for (let x = alignParity(bounds.left, parity); x < bounds.right && x + 1 < width; x += 2) {
      for (let y = bounds.top; y < bounds.bottom && y + 1 < height; y++) {
        const top = parity === 0 ? y * width + x : y * width + x + 1;
        const bottom = parity === 0 ? (y + 1) * width + x + 1 : (y + 1) * width + x;
        if (
          pixelMaterial(cells[top]!) === MATERIAL_SAND &&
          fallsThrough(cells[top]!, cells[bottom]!)
        ) {
          swap(cells, top, bottom);
          activity.markMoved(top, bottom);
          moves++;
        }
      }
    }
  });
  return moves;
}

function activeHorizontalWaterPass(
  cells: Uint32Array,
  width: number,
  height: number,
  parity: number,
  activity: PixelChunkActivity,
): number {
  let moves = 0;
  activity.forEachActiveChunk((bounds) => {
    for (let y = bounds.top; y < bounds.bottom; y++) {
      const row = y * width;
      for (let x = alignParity(bounds.left, parity); x < bounds.right && x + 1 < width; x += 2) {
        const left = row + x;
        const right = left + 1;
        const source = parity === 0 ? right : left;
        const destination = parity === 0 ? left : right;
        if (
          pixelMaterial(cells[source]!) === MATERIAL_WATER &&
          pixelMaterial(cells[destination]!) === MATERIAL_EMPTY
        ) {
          swap(cells, source, destination);
          activity.markMoved(source, destination);
          moves++;
        }
      }
    }
  });
  return moves;
}

function fallsThrough(top: number, bottom: number): boolean {
  const topMaterial = pixelMaterial(top);
  const bottomMaterial = pixelMaterial(bottom);
  if (topMaterial === MATERIAL_WALL || bottomMaterial === MATERIAL_WALL) return false;
  return density(topMaterial) > density(bottomMaterial);
}

function density(material: number): number {
  if (material === MATERIAL_SAND) return 2;
  if (material === MATERIAL_WATER) return 1;
  return 0;
}

function swap(cells: Uint32Array, left: number, right: number): void {
  const value = cells[left]!;
  cells[left] = cells[right]!;
  cells[right] = value;
}

function pixelMaterial(cell: number): number {
  return cell & 0xff;
}

function alignParity(value: number, parity: number): number {
  return (value & 1) === parity ? value : value + 1;
}

function validateWorld(cells: Uint32Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("pixel world dimensions must be positive safe integers");
  }
  if (cells.length !== width * height) {
    throw new RangeError(`pixel world must contain ${width * height} cells`);
  }
}
