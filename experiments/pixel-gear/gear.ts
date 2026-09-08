import type { PixelGearKernel } from "./kernel.ts";

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

/** Checked TS boundary for the Zig gear geometry kernel. */
export function isPixelGearCell(
  kernel: PixelGearKernel,
  gear: PixelGearState,
  x: number,
  y: number,
  angle = gear.angle,
): boolean {
  validateGear(gear);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new RangeError("pixel gear coordinates must be safe integers");
  }
  return kernel.containsGearCell(angle === gear.angle ? gear : { ...gear, angle }, x, y);
}

/**
 * Advances the rigid gear in the Zig Wasm kernel. Cells must be a view created
 * by the same kernel so the hot path performs no host/Wasm copy.
 */
export function advancePixelGear(
  kernel: PixelGearKernel,
  cells: Uint32Array,
  width: number,
  height: number,
  gear: PixelGearState,
): PixelGearStepResult {
  validateGearWorld(cells, width, height, gear);
  const nextGear = { ...gear, angle: normalizeAngle(gear.angle + gear.angularVelocity) };
  return {
    gear: nextGear,
    moves: kernel.advanceGear(cells, width, height, nextGear),
  };
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
  validateGear(gear);
}

function validateGear(gear: PixelGearState): void {
  if (
    !Number.isFinite(gear.centerX) || !Number.isFinite(gear.centerY) ||
    !Number.isFinite(gear.radius) || gear.radius <= 0 ||
    !Number.isFinite(gear.toothDepth) || gear.toothDepth < 0 ||
    !Number.isSafeInteger(gear.teeth) || gear.teeth < 3 ||
    !Number.isFinite(gear.angle) || !Number.isFinite(gear.angularVelocity)
  ) throw new RangeError("pixel gear parameters are invalid");
}
