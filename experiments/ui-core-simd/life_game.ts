export interface FixedRect {
  readonly leftFixed: number;
  readonly topFixed: number;
  readonly widthFixed: number;
  readonly heightFixed: number;
}

export interface LifeCell {
  readonly x: number;
  readonly y: number;
}

export function stepLife(
  current: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
): number {
  validateGrid(current, next, width, height);
  let live = 0;
  for (let y = 0; y < height; y++) {
    const previousY = y === 0 ? height - 1 : y - 1;
    const nextY = y + 1 === height ? 0 : y + 1;
    const row = y * width;
    const previousRow = previousY * width;
    const nextRow = nextY * width;
    for (let x = 0; x < width; x++) {
      const previousX = x === 0 ? width - 1 : x - 1;
      const nextX = x + 1 === width ? 0 : x + 1;
      const neighbors = current[previousRow + previousX] +
        current[previousRow + x] +
        current[previousRow + nextX] +
        current[row + previousX] +
        current[row + nextX] +
        current[nextRow + previousX] +
        current[nextRow + x] +
        current[nextRow + nextX];
      const alive = neighbors === 3 || (neighbors === 2 && current[row + x] !== 0) ? 1 : 0;
      next[row + x] = alive;
      live += alive;
    }
  }
  return live;
}

export function countLiveCells(cells: Uint8Array): number {
  let live = 0;
  for (let index = 0; index < cells.length; index++) live += cells[index];
  return live;
}

export function drawLifeLine(
  cells: Uint8Array,
  width: number,
  height: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  value: 0 | 1,
): void {
  let x = clampInteger(fromX, 0, width - 1);
  let y = clampInteger(fromY, 0, height - 1);
  const endX = clampInteger(toX, 0, width - 1);
  const endY = clampInteger(toY, 0, height - 1);
  const deltaX = Math.abs(endX - x);
  const stepX = x < endX ? 1 : -1;
  const deltaY = -Math.abs(endY - y);
  const stepY = y < endY ? 1 : -1;
  let error = deltaX + deltaY;
  while (true) {
    cells[y * width + x] = value;
    if (x === endX && y === endY) return;
    const doubled = error * 2;
    if (doubled >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubled <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

export function cellFromFixedPoint(
  xFixed: number,
  yFixed: number,
  rect: FixedRect,
  width: number,
  height: number,
): LifeCell {
  const x = Math.floor(((xFixed - rect.leftFixed) * width) / Math.max(1, rect.widthFixed));
  const y = Math.floor(((yFixed - rect.topFixed) * height) / Math.max(1, rect.heightFixed));
  return {
    x: clampInteger(x, 0, width - 1),
    y: clampInteger(y, 0, height - 1),
  };
}

function validateGrid(
  current: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("life grid dimensions must be positive integers");
  }
  const length = width * height;
  if (current.length !== length || next.length !== length) {
    throw new RangeError(`life grid buffers must contain ${length} cells`);
  }
  if (current.buffer === next.buffer && current.byteOffset === next.byteOffset) {
    throw new TypeError("life step requires distinct current and next buffers");
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
