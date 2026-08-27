import { add as wasmAdd, matmul as wasmMatmul, memory, scale as wasmScale } from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** A row-major, fixed-shape Float32 matrix with Wasm-resident padded rows. */
export class SimdMatrix2D {
  readonly rows: number;
  readonly columns: number;
  readonly #stride: number;
  readonly #storageLength: number;
  readonly #allocation: Allocation;
  #disposed = false;

  constructor(rows: number, columns: number) {
    if (!Number.isSafeInteger(rows) || rows < 0) throw new RangeError("invalid row count");
    if (!Number.isSafeInteger(columns) || columns < 0) {
      throw new RangeError("invalid column count");
    }
    this.rows = rows;
    this.columns = columns;
    this.#stride = Math.ceil(columns / 4) * 4;
    this.#storageLength = rows * this.#stride;
    if (!Number.isSafeInteger(this.#storageLength)) throw new RangeError("matrix is too large");
    this.#allocation = allocator.allocate(this.#storageLength * 4);
  }

  static from(rows: number, columns: number, values: ArrayLike<number>): SimdMatrix2D {
    if (values.length !== rows * columns) throw new RangeError("values length must match shape");
    const result = new SimdMatrix2D(rows, columns);
    try {
      const target = result.#view();
      for (let row = 0; row < rows; row++) {
        const sourceOffset = row * columns;
        for (let column = 0; column < columns; column++) {
          target[row * result.#stride + column] = values[sourceOffset + column]!;
        }
      }
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(row: number, column: number): number {
    this.#checkIndex(row, column);
    return this.#view()[row * this.#stride + column]!;
  }

  set(row: number, column: number, value: number): this {
    this.#checkIndex(row, column);
    this.#view()[row * this.#stride + column] = value;
    return this;
  }

  fill(value: number): this {
    const target = this.#view();
    if (value === 0) {
      target.fill(0);
      return this;
    }
    for (let row = 0; row < this.rows; row++) {
      target.subarray(row * this.#stride, row * this.#stride + this.columns).fill(value);
    }
    return this;
  }

  addAssign(other: SimdMatrix2D): this {
    this.#checkShape(other);
    wasmAdd(this.#allocation.pointer, other.#allocation.pointer, this.#storageLength);
    return this;
  }

  scaleAssign(factor: number): this {
    this.#assertAlive();
    wasmScale(this.#allocation.pointer, this.#storageLength, factor);
    return this;
  }

  multiply(right: SimdMatrix2D): SimdMatrix2D {
    this.#checkMultiply(right);
    const output = new SimdMatrix2D(this.rows, right.columns);
    try {
      return this.multiplyInto(right, output);
    } catch (error) {
      output.dispose();
      throw error;
    }
  }

  multiplyInto(right: SimdMatrix2D, output: SimdMatrix2D): SimdMatrix2D {
    this.#checkMultiply(right);
    output.#assertAlive();
    if (output === this || output === right) {
      throw new RangeError("output must not alias either input matrix");
    }
    if (output.rows !== this.rows || output.columns !== right.columns) {
      throw new RangeError("output shape must match matrix product");
    }
    output.#view().fill(0);
    wasmMatmul(
      this.#allocation.pointer,
      right.#allocation.pointer,
      output.#allocation.pointer,
      this.rows,
      this.columns,
      output.#stride,
      this.#stride,
    );
    return output;
  }

  toFloat32Array(): Float32Array {
    const source = this.#view();
    const output = new Float32Array(this.rows * this.columns);
    for (let row = 0; row < this.rows; row++) {
      output.set(
        source.subarray(row * this.#stride, row * this.#stride + this.columns),
        row * this.columns,
      );
    }
    return output;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SimdMatrix2D has been disposed");
  }

  #checkIndex(row: number, column: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rows) {
      throw new RangeError("row index out of bounds");
    }
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.columns) {
      throw new RangeError("column index out of bounds");
    }
  }

  #checkShape(other: SimdMatrix2D): void {
    this.#assertAlive();
    other.#assertAlive();
    if (this.rows !== other.rows || this.columns !== other.columns) {
      throw new RangeError("matrix shapes must match");
    }
  }

  #checkMultiply(right: SimdMatrix2D): void {
    this.#assertAlive();
    right.#assertAlive();
    if (this.columns !== right.rows) throw new RangeError("matrix inner dimensions must match");
  }

  #view(): Float32Array {
    this.#assertAlive();
    return new Float32Array(memory.buffer, this.#allocation.pointer, this.#storageLength);
  }
}
