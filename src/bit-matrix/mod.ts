import {
  boolean_multiply as wasmBooleanMultiply,
  memory,
  row_count as wasmRowCount,
  transpose as wasmTranspose,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** Dense, row-major Boolean matrix stored in Wasm linear memory. */
export class BitMatrix {
  readonly rows: number;
  readonly columns: number;
  readonly #strideWords: number;
  readonly #allocation: Allocation;
  #disposed = false;

  constructor(rows: number, columns: number) {
    this.rows = validateDimension(rows, "rows");
    this.columns = validateDimension(columns, "columns");
    this.#strideWords = (Math.ceil(columns / 32) + 3) & ~3;
    const byteLength = rows * this.#strideWords * 4;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError("matrix is too large");
    this.#allocation = allocator.allocate(byteLength);
  }

  static fromEdges(
    rows: number,
    columns: number,
    edges: Iterable<readonly [number, number]>,
  ): BitMatrix {
    const matrix = new BitMatrix(rows, columns);
    try {
      for (const [row, column] of edges) matrix.set(row, column);
      return matrix;
    } catch (error) {
      matrix[Symbol.dispose]();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  set(row: number, column: number, value = true): this {
    this.#checkCell(row, column);
    const words = this.#words();
    const index = row * this.#strideWords + (column >>> 5);
    const mask = 1 << (column & 31);
    words[index] = value ? (words[index]! | mask) >>> 0 : (words[index]! & ~mask) >>> 0;
    return this;
  }

  has(row: number, column: number): boolean {
    this.#checkCell(row, column);
    const index = row * this.#strideWords + (column >>> 5);
    return (this.#words()[index]! & (1 << (column & 31))) !== 0;
  }

  row(row: number): BitMatrixRowView {
    this.#checkRow(row);
    return new BitMatrixRowView(this, row);
  }

  countRowOnes(row: number): number {
    this.#checkRow(row);
    return wasmRowCount(
      this.#allocation.pointer + row * this.#strideWords * 4,
      this.#strideWords,
    );
  }

  rowToArray(row: number): number[] {
    this.#checkRow(row);
    const result: number[] = [];
    const words = this.#words();
    const offset = row * this.#strideWords;
    const wordCount = Math.ceil(this.columns / 32);
    for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
      let word = words[offset + wordIndex]!;
      while (word !== 0) {
        const lowest = word & -word;
        result.push((wordIndex << 5) + 31 - Math.clz32(lowest));
        word = (word & (word - 1)) >>> 0;
      }
    }
    return result;
  }

  transpose(): BitMatrix {
    this.#assertAlive();
    const result = new BitMatrix(this.columns, this.rows);
    try {
      wasmTranspose(
        this.#allocation.pointer,
        result.#allocation.pointer,
        this.rows,
        this.columns,
        this.#strideWords,
        result.#strideWords,
      );
      return result;
    } catch (error) {
      result[Symbol.dispose]();
      throw error;
    }
  }

  multiply(right: BitMatrix): BitMatrix {
    this.#assertAlive();
    right.#assertAlive();
    if (this.columns !== right.rows) throw new RangeError("matrix dimensions do not match");
    using rightTransposed = right.transpose();
    const result = new BitMatrix(this.rows, right.columns);
    try {
      wasmBooleanMultiply(
        this.#allocation.pointer,
        rightTransposed.#allocation.pointer,
        result.#allocation.pointer,
        this.rows,
        right.columns,
        this.#strideWords,
        this.#strideWords,
        rightTransposed.#strideWords,
        result.#strideWords,
      );
      return result;
    } catch (error) {
      result[Symbol.dispose]();
      throw error;
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #words(): Uint32Array {
    this.#assertAlive();
    return new Uint32Array(memory.buffer, this.#allocation.pointer, this.rows * this.#strideWords);
  }

  #checkRow(row: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rows) {
      throw new RangeError("row out of bounds");
    }
  }

  #checkCell(row: number, column: number): void {
    this.#checkRow(row);
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.columns) {
      throw new RangeError("column out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitMatrix has been disposed");
  }
}

/** Non-owning view whose lifetime is tied to its parent BitMatrix. */
export class BitMatrixRowView {
  readonly #matrix: BitMatrix;
  readonly #row: number;

  constructor(matrix: BitMatrix, row: number) {
    this.#matrix = matrix;
    this.#row = row;
  }

  has(column: number): boolean {
    return this.#matrix.has(this.#row, column);
  }

  countOnes(): number {
    return this.#matrix.countRowOnes(this.#row);
  }

  toArray(): number[] {
    return this.#matrix.rowToArray(this.#row);
  }
}

function validateDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid ${name}`);
  return value;
}
