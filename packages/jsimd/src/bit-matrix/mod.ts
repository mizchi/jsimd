import {
  boolean_multiply as wasmBooleanMultiply,
  memory,
  row_count as wasmRowCount,
  sparse_has as wasmSparseHas,
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
    const output = new Uint32Array(this.countRowOnes(row));
    this.rowPositionsInto(row, output);
    return Array.from(output);
  }

  rowPositionsInto(row: number, output: Uint32Array): number {
    this.#checkRow(row);
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    const count = this.countRowOnes(row);
    if (output.length < count) throw new RangeError("output is too small for row positions");
    const words = this.#words();
    const offset = row * this.#strideWords;
    const wordCount = Math.ceil(this.columns / 32);
    let written = 0;
    for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
      let word = words[offset + wordIndex]!;
      while (word !== 0) {
        const lowest = word & -word;
        output[written++] = (wordIndex << 5) + 31 - Math.clz32(lowest);
        word = (word & (word - 1)) >>> 0;
      }
    }
    return written;
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

  positionsInto(output: Uint32Array): number {
    return this.#matrix.rowPositionsInto(this.#row, output);
  }
}

/** Immutable compressed-sparse-row Boolean matrix stored in Wasm linear memory. */
export class SparseBitMatrix {
  readonly rows: number;
  readonly columns: number;
  readonly edgeCount: number;
  readonly #offsetsAllocation: Allocation;
  readonly #columnsAllocation: Allocation;
  #disposed = false;

  private constructor(
    rows: number,
    columns: number,
    offsets: Uint32Array,
    columnValues: Uint32Array,
  ) {
    this.rows = rows;
    this.columns = columns;
    this.edgeCount = columnValues.length;
    this.#offsetsAllocation = allocator.allocate(offsets.byteLength);
    try {
      this.#columnsAllocation = allocator.allocate(columnValues.byteLength);
    } catch (error) {
      allocator.release(this.#offsetsAllocation);
      throw error;
    }
    try {
      new Uint32Array(
        memory.buffer,
        this.#offsetsAllocation.pointer,
        offsets.length,
      ).set(offsets);
      new Uint32Array(
        memory.buffer,
        this.#columnsAllocation.pointer,
        columnValues.length,
      ).set(columnValues);
    } catch (error) {
      allocator.release(this.#columnsAllocation);
      allocator.release(this.#offsetsAllocation);
      throw error;
    }
  }

  static fromEdges(
    rows: number,
    columns: number,
    edges: Iterable<readonly [number, number]>,
  ): SparseBitMatrix {
    const rowCount = validateDimension(rows, "rows");
    const columnCount = validateDimension(columns, "columns");
    let edgePairs = new Uint32Array(0);
    let edgeCount = 0;
    for (const [row, column] of edges) {
      validateCell(row, column, rowCount, columnCount);
      if (row > 0xffff_ffff || column > 0xffff_ffff) {
        throw new RangeError("sparse matrix coordinates must fit in u32");
      }
      if (edgeCount * 2 === edgePairs.length) {
        const capacity = edgePairs.length === 0 ? 256 : edgePairs.length;
        if (!Number.isSafeInteger(capacity) || capacity > 0x7fff_ffff) {
          throw new RangeError("too many matrix edges");
        }
        const grown = new Uint32Array(capacity * 2);
        grown.set(edgePairs);
        edgePairs = grown;
      }
      edgePairs[edgeCount * 2] = row;
      edgePairs[edgeCount * 2 + 1] = column;
      edgeCount++;
    }

    const offsets = new Uint32Array(rowCount + 1);
    for (let index = 0; index < edgeCount; index++) {
      const row = edgePairs[index * 2]!;
      if (offsets[row + 1] === 0xffff_ffff) throw new RangeError("too many matrix edges");
      offsets[row + 1]++;
    }
    for (let row = 0; row < rowCount; row++) {
      if (offsets[row + 1]! > 0xffff_ffff - offsets[row]!) {
        throw new RangeError("too many matrix edges");
      }
      offsets[row + 1] += offsets[row]!;
    }

    const cursors = offsets.slice(0, rowCount);
    const columnValues = new Uint32Array(edgeCount);
    for (let index = 0; index < edgeCount; index++) {
      const row = edgePairs[index * 2]!;
      columnValues[cursors[row]!] = edgePairs[index * 2 + 1]!;
      cursors[row]++;
    }

    let outputIndex = 0;
    for (let row = 0; row < rowCount; row++) {
      const start = offsets[row]!;
      const end = offsets[row + 1]!;
      columnValues.subarray(start, end).sort();
      offsets[row] = outputIndex;
      let previous = -1;
      for (let index = start; index < end; index++) {
        const column = columnValues[index]!;
        if (column === previous) continue;
        previous = column;
        columnValues[outputIndex++] = column;
      }
    }
    offsets[rowCount] = outputIndex;
    return new SparseBitMatrix(
      rowCount,
      columnCount,
      offsets,
      columnValues.subarray(0, outputIndex),
    );
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  has(row: number, column: number): boolean {
    this.#checkCell(row, column);
    return wasmSparseHas(
      this.#offsetsAllocation.pointer,
      this.#columnsAllocation.pointer,
      row,
      column,
    ) !== 0;
  }

  row(row: number): SparseBitMatrixRowView {
    this.#checkRow(row);
    return new SparseBitMatrixRowView(this, row);
  }

  countRowOnes(row: number): number {
    this.#checkRow(row);
    const offsets = this.#offsets();
    return offsets[row + 1]! - offsets[row]!;
  }

  rowToArray(row: number): number[] {
    const output = new Uint32Array(this.countRowOnes(row));
    this.rowPositionsInto(row, output);
    return Array.from(output);
  }

  rowPositionsInto(row: number, output: Uint32Array): number {
    this.#checkRow(row);
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    const offsets = this.#offsets();
    const start = offsets[row]!;
    const end = offsets[row + 1]!;
    const count = end - start;
    if (output.length < count) throw new RangeError("output is too small for row positions");
    output.set(this.#columnValues().subarray(start, end), 0);
    return count;
  }

  transpose(): SparseBitMatrix {
    this.#assertAlive();
    const edges: Array<readonly [number, number]> = [];
    const offsets = this.#offsets();
    const values = this.#columnValues();
    for (let row = 0; row < this.rows; row++) {
      for (let index = offsets[row]!; index < offsets[row + 1]!; index++) {
        edges.push([values[index]!, row]);
      }
    }
    return SparseBitMatrix.fromEdges(this.columns, this.rows, edges);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#columnsAllocation);
    allocator.release(this.#offsetsAllocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #offsets(): Uint32Array {
    this.#assertAlive();
    return new Uint32Array(memory.buffer, this.#offsetsAllocation.pointer, this.rows + 1);
  }

  #columnValues(): Uint32Array {
    this.#assertAlive();
    return new Uint32Array(memory.buffer, this.#columnsAllocation.pointer, this.edgeCount);
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
    if (this.#disposed) throw new Error("SparseBitMatrix has been disposed");
  }
}

/** Non-owning view whose lifetime is tied to its parent SparseBitMatrix. */
export class SparseBitMatrixRowView {
  readonly #matrix: SparseBitMatrix;
  readonly #row: number;

  constructor(matrix: SparseBitMatrix, row: number) {
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

  positionsInto(output: Uint32Array): number {
    return this.#matrix.rowPositionsInto(this.#row, output);
  }
}

function validateDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid ${name}`);
  return value;
}

function validateCell(row: number, column: number, rows: number, columns: number): void {
  if (!Number.isSafeInteger(row) || row < 0 || row >= rows) {
    throw new RangeError("row out of bounds");
  }
  if (!Number.isSafeInteger(column) || column < 0 || column >= columns) {
    throw new RangeError("column out of bounds");
  }
}
