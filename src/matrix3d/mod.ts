import {
  add as wasmAdd,
  batched_matmul as wasmBatchedMatmul,
  memory,
  scale as wasmScale,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** A batch-major, fixed-shape Float32 tensor with Wasm-resident padded rows. */
export class SimdMatrix3D {
  readonly batches: number;
  readonly rows: number;
  readonly columns: number;
  readonly #stride: number;
  readonly #batchStride: number;
  readonly #storageLength: number;
  readonly #logicalLength: number;
  readonly #allocation: Allocation;
  #disposed = false;

  constructor(batches: number, rows: number, columns: number) {
    if (!Number.isSafeInteger(batches) || batches < 0) {
      throw new RangeError("invalid batch count");
    }
    if (!Number.isSafeInteger(rows) || rows < 0) throw new RangeError("invalid row count");
    if (!Number.isSafeInteger(columns) || columns < 0) {
      throw new RangeError("invalid column count");
    }
    this.batches = batches;
    this.rows = rows;
    this.columns = columns;
    this.#stride = Math.ceil(columns / 4) * 4;
    this.#batchStride = rows * this.#stride;
    this.#storageLength = batches * this.#batchStride;
    this.#logicalLength = batches * rows * columns;
    if (
      !Number.isSafeInteger(this.#batchStride) ||
      !Number.isSafeInteger(this.#storageLength) ||
      !Number.isSafeInteger(this.#logicalLength)
    ) {
      throw new RangeError("tensor is too large");
    }
    this.#allocation = allocator.allocate(this.#storageLength * 4);
  }

  static from(
    batches: number,
    rows: number,
    columns: number,
    values: ArrayLike<number>,
  ): SimdMatrix3D {
    const result = new SimdMatrix3D(batches, rows, columns);
    try {
      if (values.length !== result.#logicalLength) {
        throw new RangeError("values length must match shape");
      }
      const target = result.#view();
      for (let batch = 0; batch < batches; batch++) {
        for (let row = 0; row < rows; row++) {
          const sourceOffset = (batch * rows + row) * columns;
          const targetOffset = batch * result.#batchStride + row * result.#stride;
          for (let column = 0; column < columns; column++) {
            target[targetOffset + column] = values[sourceOffset + column]!;
          }
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

  get(batch: number, row: number, column: number): number {
    this.#checkIndex(batch, row, column);
    return this.#view()[batch * this.#batchStride + row * this.#stride + column]!;
  }

  set(batch: number, row: number, column: number, value: number): this {
    this.#checkIndex(batch, row, column);
    this.#view()[batch * this.#batchStride + row * this.#stride + column] = value;
    return this;
  }

  fill(value: number): this {
    const target = this.#view();
    if (value === 0) {
      target.fill(0);
      return this;
    }
    for (let batch = 0; batch < this.batches; batch++) {
      for (let row = 0; row < this.rows; row++) {
        const offset = batch * this.#batchStride + row * this.#stride;
        target.subarray(offset, offset + this.columns).fill(value);
      }
    }
    return this;
  }

  addAssign(other: SimdMatrix3D): this {
    this.#checkShape(other);
    wasmAdd(this.#allocation.pointer, other.#allocation.pointer, this.#storageLength);
    return this;
  }

  scaleAssign(factor: number): this {
    this.#assertAlive();
    wasmScale(this.#allocation.pointer, this.#storageLength, factor);
    return this;
  }

  batchMultiply(right: SimdMatrix3D): SimdMatrix3D {
    this.#checkMultiply(right);
    const output = new SimdMatrix3D(this.batches, this.rows, right.columns);
    try {
      return this.batchMultiplyInto(right, output);
    } catch (error) {
      output.dispose();
      throw error;
    }
  }

  batchMultiplyInto(right: SimdMatrix3D, output: SimdMatrix3D): SimdMatrix3D {
    this.#checkMultiply(right);
    output.#assertAlive();
    if (output === this || output === right) {
      throw new RangeError("output must not alias either input tensor");
    }
    if (
      output.batches !== this.batches ||
      output.rows !== this.rows ||
      output.columns !== right.columns
    ) {
      throw new RangeError("output shape must match batched matrix product");
    }
    output.#view().fill(0);
    wasmBatchedMatmul(
      this.#allocation.pointer,
      right.#allocation.pointer,
      output.#allocation.pointer,
      this.batches,
      this.rows,
      this.columns,
      output.#stride,
      this.#stride,
    );
    return output;
  }

  toFloat32Array(): Float32Array {
    const source = this.#view();
    const output = new Float32Array(this.#logicalLength);
    for (let batch = 0; batch < this.batches; batch++) {
      for (let row = 0; row < this.rows; row++) {
        const sourceOffset = batch * this.#batchStride + row * this.#stride;
        const outputOffset = (batch * this.rows + row) * this.columns;
        output.set(source.subarray(sourceOffset, sourceOffset + this.columns), outputOffset);
      }
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
    if (this.#disposed) throw new Error("SimdMatrix3D has been disposed");
  }

  #checkIndex(batch: number, row: number, column: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(batch) || batch < 0 || batch >= this.batches) {
      throw new RangeError("batch index out of bounds");
    }
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.rows) {
      throw new RangeError("row index out of bounds");
    }
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.columns) {
      throw new RangeError("column index out of bounds");
    }
  }

  #checkShape(other: SimdMatrix3D): void {
    this.#assertAlive();
    other.#assertAlive();
    if (
      this.batches !== other.batches ||
      this.rows !== other.rows ||
      this.columns !== other.columns
    ) {
      throw new RangeError("tensor shapes must match");
    }
  }

  #checkMultiply(right: SimdMatrix3D): void {
    this.#assertAlive();
    right.#assertAlive();
    if (this.batches !== right.batches) throw new RangeError("tensor batch counts must match");
    if (this.columns !== right.rows) {
      throw new RangeError("matrix inner dimensions must match");
    }
  }

  #view(): Float32Array {
    this.#assertAlive();
    return new Float32Array(memory.buffer, this.#allocation.pointer, this.#storageLength);
  }
}
