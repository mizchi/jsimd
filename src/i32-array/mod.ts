import {
  add as wasmAdd,
  equal as wasmEqual,
  max as wasmMax,
  memory,
  min as wasmMin,
  sum as wasmSum,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** A fixed-length, Wasm-resident signed 32-bit array for repeated SIMD bulk operations. */
export class SimdInt32Array {
  readonly length: number;
  readonly #allocation: Allocation;
  readonly #paddedLength: number;
  #disposed = false;

  constructor(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("invalid array length");
    this.length = length;
    this.#paddedLength = (length + 3) & ~3;
    this.#allocation = allocator.allocate(this.#paddedLength * 4);
  }

  static from(values: ArrayLike<number>): SimdInt32Array {
    const result = new SimdInt32Array(values.length);
    try {
      result.#view().set(values);
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(index: number): number {
    this.#checkIndex(index);
    return this.#view()[index]!;
  }

  set(index: number, value: number): this {
    this.#checkIndex(index);
    this.#view()[index] = value;
    return this;
  }

  fill(value: number): this {
    this.#view().subarray(0, this.length).fill(value);
    return this;
  }

  sum(): number {
    this.#assertAlive();
    return Number(wasmSum(this.#allocation.pointer, this.length));
  }

  min(): number {
    this.#assertNonEmpty();
    return wasmMin(this.#allocation.pointer, this.length);
  }

  max(): number {
    this.#assertNonEmpty();
    return wasmMax(this.#allocation.pointer, this.length);
  }

  equals(other: SimdInt32Array): boolean {
    this.#checkOther(other);
    return wasmEqual(this.#allocation.pointer, other.#allocation.pointer, this.#paddedLength) !== 0;
  }

  addAssign(other: SimdInt32Array): this {
    this.#checkOther(other);
    wasmAdd(this.#allocation.pointer, other.#allocation.pointer, this.#paddedLength);
    return this;
  }

  clone(): SimdInt32Array {
    this.#assertAlive();
    const result = new SimdInt32Array(this.length);
    result.#view().set(this.#view());
    return result;
  }

  toInt32Array(): Int32Array {
    return this.#view().slice(0, this.length);
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
    if (this.#disposed) throw new Error("SimdInt32Array has been disposed");
  }

  #assertNonEmpty(): void {
    this.#assertAlive();
    if (this.length === 0) throw new RangeError("operation requires a non-empty array");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("array index out of bounds");
    }
  }

  #checkOther(other: SimdInt32Array): void {
    this.#assertAlive();
    other.#assertAlive();
    if (this.length !== other.length) throw new RangeError("array lengths must match");
  }

  #view(): Int32Array {
    this.#assertAlive();
    return new Int32Array(memory.buffer, this.#allocation.pointer, this.#paddedLength);
  }
}
