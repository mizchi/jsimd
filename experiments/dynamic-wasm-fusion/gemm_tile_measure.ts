import { compileF32Gemm, type F32GemmRowTile } from "./mod.ts";

export interface F32GemmTileMeasurementOptions {
  readonly rows: number;
  readonly inner: number;
  readonly columns: number;
  readonly rowTile: F32GemmRowTile;
  readonly warmups: number;
  readonly samples: number;
  readonly operationsPerSample: number;
}

export interface F32GemmTileMeasurement {
  readonly rows: number;
  readonly inner: number;
  readonly columns: number;
  readonly rowTile: F32GemmRowTile;
  readonly moduleBytes: number;
  readonly samplesMs: readonly number[];
  readonly checksum: number;
}

export async function measureF32GemmRowTile(
  options: F32GemmTileMeasurementOptions,
): Promise<F32GemmTileMeasurement> {
  const rows = positiveInteger(options.rows, "rows");
  const inner = positiveInteger(options.inner, "inner");
  const columns = positiveInteger(options.columns, "columns");
  const warmups = nonNegativeInteger(options.warmups, "warmups");
  const samples = positiveInteger(options.samples, "samples");
  const operationsPerSample = positiveInteger(
    options.operationsPerSample,
    "operationsPerSample",
  );
  const aElements = rows * inner;
  const bElements = inner * columns;
  const cElements = rows * columns;
  const aBytes = align16(aElements * 4);
  const bBytes = align16(bElements * 4);
  const aPointer = 0;
  const bPointer = aBytes;
  const cPointer = bPointer + bBytes;
  const memory = new WebAssembly.Memory({
    initial: Math.max(1, Math.ceil((cPointer + cElements * 4) / 65_536)),
  });
  const a = new Float32Array(memory.buffer, aPointer, aElements);
  const b = new Float32Array(memory.buffer, bPointer, bElements);
  const c = new Float32Array(memory.buffer, cPointer, cElements);
  fill(a, 17, 101);
  fill(b, 29, 97);
  const compiled = await compileF32Gemm({ rows, inner, columns, rowTile: options.rowTile });
  const kernel = await compiled.instantiate(memory);
  kernel.run(aPointer, bPointer, cPointer, 0);
  const expectedLast = referenceCell(a, b, rows - 1, columns - 1, inner, columns);
  assertClose(c[cElements - 1]!, expectedLast);

  let checksum = 0;
  for (let iteration = 0; iteration < warmups; iteration++) {
    kernel.run(aPointer, bPointer, cPointer, 0);
    checksum += c[cElements - 1]!;
  }
  const samplesMs: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const started = performance.now();
    for (let operation = 0; operation < operationsPerSample; operation++) {
      kernel.run(aPointer, bPointer, cPointer, 0);
      checksum += c[cElements - 1]!;
    }
    samplesMs.push((performance.now() - started) / operationsPerSample);
  }
  return {
    rows,
    inner,
    columns,
    rowTile: options.rowTile,
    moduleBytes: compiled.bytes.byteLength,
    samplesMs,
    checksum,
  };
}

function referenceCell(
  a: Float32Array,
  b: Float32Array,
  row: number,
  column: number,
  inner: number,
  columns: number,
): number {
  let sum = 0;
  for (let index = 0; index < inner; index++) {
    sum = Math.fround(
      sum + Math.fround(a[row * inner + index]! * b[index * columns + column]!),
    );
  }
  return sum;
}

function fill(values: Float32Array, multiplier: number, modulus: number): void {
  for (let index = 0; index < values.length; index++) {
    values[index] = ((index * multiplier + 3) % modulus - Math.floor(modulus / 2)) / 32;
  }
}

function assertClose(actual: number, expected: number): void {
  const tolerance = Math.max(1e-4, Math.abs(expected) * 2e-5);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`generated GEMM returned ${actual}, expected ${expected}`);
  }
}

function align16(value: number): number {
  return (value + 15) & ~15;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
