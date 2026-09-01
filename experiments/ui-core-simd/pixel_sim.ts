import type { PixelRegion } from "./pixel_options.ts";

export const MATERIAL = {
  empty: 0,
  wall: 1,
  sand: 2,
  water: 3,
} as const;

export type PixelMaterial = (typeof MATERIAL)[keyof typeof MATERIAL];

export interface PixelStepResult {
  readonly moves: number;
}

const MATERIAL_MASK = 0xff;
const TEMPERATURE_SHIFT = 8;
const FLAGS_SHIFT = 16;
const VARIANT_SHIFT = 24;

export function packPixel(
  material: PixelMaterial,
  temperature = 128,
  flags = 0,
  variant = 0,
): number {
  byte(material, "material");
  byte(temperature, "temperature");
  byte(flags, "flags");
  byte(variant, "variant");
  return (
    material |
    temperature << TEMPERATURE_SHIFT |
    flags << FLAGS_SHIFT |
    variant << VARIANT_SHIFT
  ) >>> 0;
}

export function pixelMaterial(cell: number): number {
  return cell & MATERIAL_MASK;
}

export function pixelTemperature(cell: number): number {
  return cell >>> TEMPERATURE_SHIFT & MATERIAL_MASK;
}

export function pixelFlags(cell: number): number {
  return cell >>> FLAGS_SHIFT & MATERIAL_MASK;
}

export function pixelVariant(cell: number): number {
  return cell >>> VARIANT_SHIFT & MATERIAL_MASK;
}

/**
 * Advances a material cellular automaton in-place through disjoint pair passes.
 * Every pass only swaps complete u32 cells, so material and metadata are conserved.
 * The same pairing contract is used by the optional WebGPU implementation.
 */
export function stepPixelWorld(
  cells: Uint32Array,
  width: number,
  height: number,
  phase: number,
): PixelStepResult {
  validateWorld(cells, width, height);
  if (!Number.isSafeInteger(phase) || phase < 0) {
    throw new RangeError("pixel simulation phase must be a non-negative safe integer");
  }
  const parity = phase & 1;
  let moves = verticalPass(cells, width, height, parity);
  moves += diagonalPass(cells, width, height, parity);
  moves += horizontalWaterPass(cells, width, height, parity);
  return { moves };
}

export function countPixelMaterials(cells: Uint32Array): readonly number[] {
  const counts = new Array<number>(4).fill(0);
  for (let index = 0; index < cells.length; index++) {
    const material = pixelMaterial(cells[index]!);
    if (material >= counts.length) counts.length = material + 1;
    counts[material] = (counts[material] ?? 0) + 1;
  }
  return counts;
}

export function paintPixelCircle(
  cells: Uint32Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  material: PixelMaterial,
): void {
  validateWorld(cells, width, height);
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError("brush radius must be positive");
  const packed = packPixel(material);
  const integerRadius = Math.ceil(radius);
  const radiusSquared = radius * radius;
  const startX = Math.max(0, Math.floor(centerX) - integerRadius);
  const endX = Math.min(width - 1, Math.floor(centerX) + integerRadius);
  const startY = Math.max(0, Math.floor(centerY) - integerRadius);
  const endY = Math.min(height - 1, Math.floor(centerY) + integerRadius);
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const deltaX = x - centerX;
      const deltaY = y - centerY;
      if (deltaX * deltaX + deltaY * deltaY <= radiusSquared) cells[y * width + x] = packed;
    }
  }
}

/** Reconstructs a continuous brush stroke after pointer-move coalescing. */
export function paintPixelLine(
  cells: Uint32Array,
  width: number,
  height: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  material: PixelMaterial,
): void {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY))));
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    paintPixelCircle(
      cells,
      width,
      height,
      Math.round(fromX + deltaX * progress),
      Math.round(fromY + deltaY * progress),
      radius,
      material,
    );
  }
}

export function createPixelScenario(
  width: number,
  height: number,
  occupancy = 0.25,
  seed = 0x51f1_5e5d,
  region: PixelRegion = "full",
): Uint32Array {
  if (!Number.isFinite(occupancy) || occupancy < 0 || occupancy > 1) {
    throw new RangeError("pixel scenario occupancy must be between zero and one");
  }
  const cells = new Uint32Array(width * height);
  validateWorld(cells, width, height);
  const empty = packPixel(MATERIAL.empty);
  const wall = packPixel(MATERIAL.wall);
  const sand = packPixel(MATERIAL.sand);
  const water = packPixel(MATERIAL.water);
  cells.fill(empty);
  for (let x = 0; x < width; x++) cells[(height - 1) * width + x] = wall;
  const scale = region === "full" ? 1 : region === "quarter" ? 0.5 : 0.25;
  const regionWidth = Math.max(1, Math.floor(width * scale));
  const regionHeight = Math.max(1, Math.floor((height - 1) * scale));
  const regionLeft = Math.floor((width - regionWidth) / 2);
  const regionTop = Math.min(Math.max(0, height - 2), Math.floor(height * 0.05));
  for (let y = regionTop; y < Math.min(height - 1, regionTop + regionHeight); y++) {
    for (let x = regionLeft; x < regionLeft + regionWidth; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const sample = (seed >>> 0) / 0x1_0000_0000;
      if (sample >= occupancy) continue;
      cells[y * width + x] = (seed >>> 8 & 1) === 0 ? sand : water;
    }
  }
  const shelfY = Math.floor(height * 0.62);
  for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.44); x++) {
    cells[shelfY * width + x] = wall;
  }
  return cells;
}

function verticalPass(cells: Uint32Array, width: number, height: number, parity: number): number {
  let moves = 0;
  for (let y = parity; y + 1 < height; y += 2) {
    const topRow = y * width;
    const bottomRow = topRow + width;
    for (let x = 0; x < width; x++) {
      const top = topRow + x;
      const bottom = bottomRow + x;
      if (fallsThrough(cells[top]!, cells[bottom]!)) {
        swap(cells, top, bottom);
        moves++;
      }
    }
  }
  return moves;
}

function diagonalPass(cells: Uint32Array, width: number, height: number, parity: number): number {
  let moves = 0;
  for (let x = parity; x + 1 < width; x += 2) {
    for (let y = 0; y + 1 < height; y++) {
      const top = parity === 0 ? y * width + x : y * width + x + 1;
      const bottom = parity === 0 ? (y + 1) * width + x + 1 : (y + 1) * width + x;
      if (
        pixelMaterial(cells[top]!) === MATERIAL.sand &&
        fallsThrough(cells[top]!, cells[bottom]!)
      ) {
        swap(cells, top, bottom);
        moves++;
      }
    }
  }
  return moves;
}

function horizontalWaterPass(
  cells: Uint32Array,
  width: number,
  height: number,
  parity: number,
): number {
  let moves = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = parity; x + 1 < width; x += 2) {
      const left = row + x;
      const right = left + 1;
      const source = parity === 0 ? right : left;
      const destination = parity === 0 ? left : right;
      if (
        pixelMaterial(cells[source]!) === MATERIAL.water &&
        pixelMaterial(cells[destination]!) === MATERIAL.empty
      ) {
        swap(cells, source, destination);
        moves++;
      }
    }
  }
  return moves;
}

function fallsThrough(top: number, bottom: number): boolean {
  const topMaterial = pixelMaterial(top);
  const bottomMaterial = pixelMaterial(bottom);
  if (topMaterial === MATERIAL.wall || bottomMaterial === MATERIAL.wall) return false;
  return density(topMaterial) > density(bottomMaterial);
}

function density(material: number): number {
  if (material === MATERIAL.sand) return 2;
  if (material === MATERIAL.water) return 1;
  return 0;
}

function swap(cells: Uint32Array, left: number, right: number): void {
  const value = cells[left]!;
  cells[left] = cells[right]!;
  cells[right] = value;
}

function validateWorld(cells: Uint32Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("pixel world dimensions must be positive safe integers");
  }
  if (cells.length !== width * height) {
    throw new RangeError(`pixel world must contain ${width * height} cells`);
  }
}

function byte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an unsigned byte`);
  }
}
