import { MATERIAL, packPixel, pixelMaterial } from "../ui-core-simd/pixel_sim.ts";

export interface PixelGearState {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly toothDepth: number;
  readonly teeth: number;
  readonly angle: number;
  readonly angularVelocity: number;
}

export interface PixelGearStepResult {
  readonly gear: PixelGearState;
  readonly moves: number;
}

const TAU = Math.PI * 2;

/** Returns whether a world cell is occupied by the solid body of a gear. */
export function isPixelGearCell(
  gear: PixelGearState,
  x: number,
  y: number,
  angle = gear.angle,
): boolean {
  const deltaX = x + 0.5 - gear.centerX;
  const deltaY = y + 0.5 - gear.centerY;
  const distanceSquared = deltaX * deltaX + deltaY * deltaY;
  if (distanceSquared > (gear.radius + gear.toothDepth) ** 2) return false;
  const direction = Math.atan2(deltaY, deltaX);
  const wave = (Math.cos((direction - angle) * gear.teeth) + 1) * 0.5;
  const outerRadius = gear.radius + gear.toothDepth * wave ** 4;
  return distanceSquared <= outerRadius * outerRadius;
}

/**
 * Advances a separately-owned rigid gear and pushes any overlapping movable
 * material along its tangential motion. Complete u32 cells are moved, keeping
 * the pixel material ABI and metadata intact.
 */
export function advancePixelGear(
  cells: Uint32Array,
  width: number,
  height: number,
  gear: PixelGearState,
): PixelGearStepResult {
  validateGearWorld(cells, width, height, gear);
  const nextGear = { ...gear, angle: normalizeAngle(gear.angle + gear.angularVelocity) };
  const reach = gear.radius + gear.toothDepth;
  const startX = Math.max(0, Math.floor(gear.centerX - reach - 1));
  const endX = Math.min(width - 1, Math.ceil(gear.centerX + reach + 1));
  const startY = Math.max(0, Math.floor(gear.centerY - reach - 1));
  const endY = Math.min(height - 1, Math.ceil(gear.centerY + reach + 1));
  const empty = packPixel(MATERIAL.empty);
  let moves = 0;

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const source = y * width + x;
      const material = pixelMaterial(cells[source]!);
      if (
        (material !== MATERIAL.sand && material !== MATERIAL.water) ||
        !isPixelGearCell(nextGear, x, y)
      ) continue;
      const destination = findDestination(cells, width, height, nextGear, x, y);
      if (destination < 0) continue;
      cells[destination] = cells[source]!;
      cells[source] = empty;
      moves++;
    }
  }
  return { gear: nextGear, moves };
}

function findDestination(
  cells: Uint32Array,
  width: number,
  height: number,
  gear: PixelGearState,
  sourceX: number,
  sourceY: number,
): number {
  const deltaX = sourceX + 0.5 - gear.centerX;
  const deltaY = sourceY + 0.5 - gear.centerY;
  const radius = Math.hypot(deltaX, deltaY);
  const normalX = radius === 0 ? 0 : deltaX / radius;
  const normalY = radius === 0 ? -1 : deltaY / radius;
  const rotation = Math.sign(gear.angularVelocity) || 1;
  const tangentX = -normalY * rotation;
  const tangentY = normalX * rotation;
  const tangentialTravel = Math.max(
    1,
    Math.ceil(Math.abs(gear.angularVelocity) * (gear.radius + gear.toothDepth)),
  );
  const searchDistance = Math.ceil(gear.radius + gear.toothDepth + tangentialTravel + 2);

  for (let distance = 1; distance <= searchDistance; distance++) {
    const travel = Math.min(distance, tangentialTravel);
    for (const outward of [distance * 0.65, distance, distance * 0.35]) {
      const x = Math.round(sourceX + tangentX * travel + normalX * outward);
      const y = Math.round(sourceY + tangentY * travel + normalY * outward);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const destination = y * width + x;
      if (
        pixelMaterial(cells[destination]!) === MATERIAL.empty &&
        !isPixelGearCell(gear, x, y)
      ) return destination;
    }
  }
  return -1;
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

function validateGearWorld(
  cells: Uint32Array,
  width: number,
  height: number,
  gear: PixelGearState,
): void {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    cells.length !== width * height
  ) throw new RangeError("pixel gear world dimensions do not match its cells");
  if (
    !Number.isFinite(gear.centerX) || !Number.isFinite(gear.centerY) ||
    !Number.isFinite(gear.radius) || gear.radius <= 0 ||
    !Number.isFinite(gear.toothDepth) || gear.toothDepth < 0 ||
    !Number.isSafeInteger(gear.teeth) || gear.teeth < 3 ||
    !Number.isFinite(gear.angle) || !Number.isFinite(gear.angularVelocity)
  ) throw new RangeError("pixel gear parameters are invalid");
}
