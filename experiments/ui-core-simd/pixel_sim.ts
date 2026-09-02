import type { PixelRegion } from "./pixel_options.ts";
import {
  MATERIAL,
  materialDensity,
  materialIsFluid,
  materialIsMovable,
  type PixelMaterial,
} from "./pixel_material.ts";

export { MATERIAL, type PixelMaterial } from "./pixel_material.ts";

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
  moves += horizontalFluidPass(cells, width, height, parity);
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
  const packed = packPixel(material, 128);
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
  for (let x = 0; x < width; x++) {
    cells[x] = wall;
    cells[(height - 1) * width + x] = wall;
  }
  for (let y = 0; y < height; y++) {
    cells[y * width] = wall;
    cells[y * width + width - 1] = wall;
  }
  return cells;
}

/** Demo-only gallery with raw materials above and live compound reactions below. */
export function createPixelMaterialShowcase(
  width: number,
  height: number,
  occupancy = 0.25,
  seed = 0x51f1_5e5d,
  region: PixelRegion = "full",
): Uint32Array {
  if (!Number.isFinite(occupancy) || occupancy < 0 || occupancy > 1) {
    throw new RangeError("pixel showcase occupancy must be between zero and one");
  }
  const cells = new Uint32Array(width * height);
  validateWorld(cells, width, height);
  cells.fill(packPixel(MATERIAL.empty));
  const columns = 5;
  const rows = 2;
  const [galleryLeft, galleryTop, galleryWidth, galleryHeight] = pixelShowcaseBounds(
    width,
    height,
    region,
  );
  const fillProbability = Math.min(1, 0.25 + occupancy);
  const wall = packPixel(MATERIAL.wall);

  for (let slot = 0; slot < columns * rows; slot++) {
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const left = galleryLeft + Math.floor(column * galleryWidth / columns);
    const right = galleryLeft + Math.floor((column + 1) * galleryWidth / columns) - 1;
    const top = galleryTop + Math.floor(row * galleryHeight / rows);
    const bottom = galleryTop + Math.floor((row + 1) * galleryHeight / rows) - 1;
    for (let x = left; x <= right; x++) {
      cells[top * width + x] = wall;
      cells[bottom * width + x] = wall;
    }
    for (let y = top; y <= bottom; y++) {
      cells[y * width + left] = wall;
      cells[y * width + right] = wall;
    }

    if (row !== 0) continue;
    const pairs = [
      [MATERIAL.sand, MATERIAL.water],
      [MATERIAL.gas, MATERIAL.smoke],
      [MATERIAL.stone, MATERIAL.wood],
      [MATERIAL.oil, MATERIAL.acid],
      [MATERIAL.fire, MATERIAL.lava],
    ] as const;
    const middle = Math.floor((left + right) / 2);
    for (let y = top + 1; y < bottom; y++) cells[y * width + middle] = wall;
    for (let side = 0; side < 2; side++) {
      const material = pairs[column]![side]!;
      const packed = packPixel(
        material,
        material === MATERIAL.fire || material === MATERIAL.lava ? 255 : 128,
      );
      const startX = side === 0 ? left + 1 : middle + 1;
      const endX = side === 0 ? middle : right;
      for (let y = top + 1; y < bottom; y++) {
        for (let x = startX; x < endX; x++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          if ((seed >>> 0) / 0x1_0000_0000 < fillProbability) cells[y * width + x] = packed;
        }
      }
      cells[(bottom - 1) * width + Math.floor((startX + endX - 1) / 2)] = packed;
    }
  }

  seedPixelMaterialShowcaseInteractions(cells, width, height, region);

  for (let x = 0; x < width; x++) {
    cells[x] = wall;
    cells[(height - 1) * width + x] = wall;
  }
  for (let y = 0; y < height; y++) {
    cells[y * width] = wall;
    cells[y * width + width - 1] = wall;
  }
  return cells;
}

/** Restores small material sources so the demo keeps showing reactions after reaching equilibrium. */
export function seedPixelMaterialShowcaseInteractions(
  cells: Uint32Array,
  width: number,
  height: number,
  region: PixelRegion = "full",
): void {
  validateWorld(cells, width, height);
  const [galleryLeft, galleryTop, galleryWidth, galleryHeight] = pixelShowcaseBounds(
    width,
    height,
    region,
  );
  const rowTop = galleryTop + Math.floor(galleryHeight / 2);
  const sourcePairs = [
    [MATERIAL.sand, MATERIAL.water],
    [MATERIAL.fire, MATERIAL.water],
    [MATERIAL.lava, MATERIAL.water],
    [MATERIAL.acid, MATERIAL.wood],
    [MATERIAL.fire, MATERIAL.oil],
  ] as const;
  for (let column = 0; column < sourcePairs.length; column++) {
    const left = galleryLeft + Math.floor(column * galleryWidth / 5);
    const right = galleryLeft + Math.floor((column + 1) * galleryWidth / 5) - 1;
    const bottom = galleryTop + galleryHeight - 1;
    const middleX = Math.floor((left + right) / 2);
    const spanX = Math.max(1, Math.floor((right - left - 1) * 0.16));
    const spanY = Math.max(2, Math.floor((bottom - rowTop - 1) * 0.22));
    const [first, second] = sourcePairs[column]!;
    if (column === 0) {
      fillPixelRect(
        cells,
        width,
        middleX - spanX,
        rowTop + 2,
        middleX + spanX,
        rowTop + spanY,
        first,
      );
      fillPixelRect(
        cells,
        width,
        middleX - spanX,
        bottom - spanY,
        middleX + spanX,
        bottom - 1,
        second,
      );
      continue;
    }
    for (let y = bottom - spanY; y < bottom; y++) {
      const secondMaterial = column === 3 && (y & 1) === 0
        ? MATERIAL.stone
        : column === 4 && (y & 1) === 0
        ? MATERIAL.wood
        : second;
      fillPixelRect(cells, width, middleX - spanX, y, middleX, y, first);
      fillPixelRect(cells, width, middleX + 1, y, middleX + spanX + 1, y, secondMaterial);
    }
  }
}

function pixelShowcaseBounds(
  width: number,
  height: number,
  region: PixelRegion,
): readonly [number, number, number, number] {
  const scale = region === "full" ? 0.94 : region === "quarter" ? 0.5 : 0.3;
  const galleryWidth = Math.max(20, Math.floor((width - 2) * scale));
  const galleryHeight = Math.max(8, Math.floor((height - 2) * scale));
  return [
    Math.max(1, Math.floor((width - galleryWidth) / 2)),
    Math.max(1, Math.floor((height - galleryHeight) / 2)),
    galleryWidth,
    galleryHeight,
  ];
}

function fillPixelRect(
  cells: Uint32Array,
  width: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  material: PixelMaterial,
): void {
  const packed = packPixel(
    material,
    material === MATERIAL.fire || material === MATERIAL.lava ? 255 : 128,
  );
  for (let y = top; y <= bottom; y++) cells.fill(packed, y * width + left, y * width + right + 1);
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

function horizontalFluidPass(
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
        materialIsFluid(pixelMaterial(cells[source]!)) &&
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
  if (topMaterial !== MATERIAL.empty && !materialIsMovable(topMaterial)) return false;
  if (bottomMaterial !== MATERIAL.empty && !materialIsMovable(bottomMaterial)) return false;
  return materialDensity(topMaterial) > materialDensity(bottomMaterial);
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
