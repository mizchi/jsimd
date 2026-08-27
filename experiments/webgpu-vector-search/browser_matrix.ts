export interface BatchCrossoverMeasurement {
  readonly rows: number;
  readonly batches: readonly {
    readonly queryCount: number;
    readonly wasmMedianMs: number;
    readonly webgpuMedianMs: number;
  }[];
}

export function makeValues(rows: number, dimensions: number): Float32Array {
  positiveInteger(rows, "rows");
  positiveInteger(dimensions, "dimensions");
  const values = new Float32Array(rows * dimensions);
  let random = 0x9e37_79b9;
  for (let index = 0; index < values.length; index++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    values[index] = (random >>> 8) / 0x80_0000 - 1;
  }
  return values;
}

export function makeQueries(
  values: Float32Array,
  rows: number,
  dimensions: number,
  queryCount: number,
): Float32Array {
  positiveInteger(rows, "rows");
  positiveInteger(dimensions, "dimensions");
  positiveInteger(queryCount, "queryCount");
  if (values.length !== rows * dimensions) throw new RangeError("values do not match the shape");
  const queries = new Float32Array(queryCount * dimensions);
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
    const row = Math.imul(queryIndex, 9_973) % rows;
    queries.set(
      values.subarray(row * dimensions, (row + 1) * dimensions),
      queryIndex * dimensions,
    );
  }
  return queries;
}

export function assertSameTopK(
  expectedIds: Uint32Array,
  expectedDistances: Float32Array,
  actualIds: Uint32Array,
  actualDistances: Float32Array,
): void {
  if (
    expectedIds.length !== actualIds.length ||
    expectedDistances.length !== actualDistances.length ||
    expectedIds.length !== expectedDistances.length
  ) throw new RangeError("top-k result lengths differ");
  for (let rank = 0; rank < expectedIds.length; rank++) {
    if (expectedIds[rank] !== actualIds[rank]) {
      throw new Error(
        `top-k id differs at rank ${rank}: expected ${expectedIds[rank]}, received ${
          actualIds[rank]
        }`,
      );
    }
    const expected = expectedDistances[rank]!;
    const actual = actualDistances[rank]!;
    const tolerance = Math.max(1e-4, Math.abs(expected) * 1e-5);
    if (Math.abs(expected - actual) > tolerance) {
      throw new Error(
        `top-k distance differs at rank ${rank}: expected ${expected}, received ${actual}`,
      );
    }
  }
}

export function firstBatchCrossover(
  measurements: readonly BatchCrossoverMeasurement[],
  queryCount: number,
): number | null {
  positiveInteger(queryCount, "queryCount");
  for (const measurement of measurements) {
    const batch = measurement.batches.find((candidate) => candidate.queryCount === queryCount);
    if (batch !== undefined && batch.webgpuMedianMs < batch.wasmMedianMs) return measurement.rows;
  }
  return null;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
