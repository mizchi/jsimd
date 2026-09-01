export const PIXEL_WORKGROUP_SIZE = 64;

export interface PixelPassPlan {
  readonly parity: 0 | 1;
  readonly verticalPairs: number;
  readonly diagonalPairs: number;
  readonly horizontalPairs: number;
  readonly verticalWorkgroups: number;
  readonly diagonalWorkgroups: number;
  readonly horizontalWorkgroups: number;
}

export function createPixelPassPlan(width: number, height: number, phase: number): PixelPassPlan {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (!Number.isSafeInteger(phase) || phase < 0) {
    throw new RangeError("phase must be a non-negative safe integer");
  }
  const parity = (phase & 1) as 0 | 1;
  const verticalRows = Math.max(0, Math.floor((height - parity) / 2));
  const pairedColumns = Math.max(0, Math.floor((width - parity) / 2));
  const verticalPairs = verticalRows * width;
  const diagonalPairs = pairedColumns * Math.max(0, height - 1);
  const horizontalPairs = pairedColumns * height;
  return {
    parity,
    verticalPairs,
    diagonalPairs,
    horizontalPairs,
    verticalWorkgroups: groups(verticalPairs),
    diagonalWorkgroups: groups(diagonalPairs),
    horizontalWorkgroups: groups(horizontalPairs),
  };
}

function groups(pairCount: number): number {
  return Math.ceil(pairCount / PIXEL_WORKGROUP_SIZE);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
