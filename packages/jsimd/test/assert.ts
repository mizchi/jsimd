export function assertEquals(actual: unknown, expected: unknown, context: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${context}: expected ${expected}, got ${actual}`);
  }
}

export function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  context: string,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${context}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

export function rangeBy(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value < end; value += step) values.push(value);
  return values;
}
