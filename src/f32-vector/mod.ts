import {
  axpy,
  cosine_similarity as wasmCosineSimilarity,
  dot as wasmDot,
  memory,
  norm as wasmNorm,
  squared_distance as wasmSquaredDistance,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

export class SimdFloat32Vector {
  readonly length: number;
  readonly #allocation: Allocation;
  readonly #paddedLength: number;
  #disposed = false;

  constructor(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("invalid vector length");
    this.length = length;
    this.#paddedLength = (length + 3) & ~3;
    this.#allocation = allocator.allocate(this.#paddedLength * 4);
  }

  static from(values: ArrayLike<number>): SimdFloat32Vector {
    const result = new SimdFloat32Vector(values.length);
    result.#view().set(values);
    return result;
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SimdFloat32Vector has been disposed");
  }

  #view(): Float32Array {
    this.#assertAlive();
    return new Float32Array(memory.buffer, this.#allocation.pointer, this.#paddedLength);
  }

  #check(other: SimdFloat32Vector): void {
    this.#assertAlive();
    other.#assertAlive();
    if (this.length !== other.length) throw new RangeError("vector lengths must match");
  }

  dot(other: SimdFloat32Vector): number {
    this.#check(other);
    return wasmDot(this.#allocation.pointer, other.#allocation.pointer, this.#paddedLength);
  }

  squaredDistance(other: SimdFloat32Vector): number {
    this.#check(other);
    return wasmSquaredDistance(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#paddedLength,
    );
  }

  norm(): number {
    this.#assertAlive();
    return wasmNorm(this.#allocation.pointer, this.#paddedLength);
  }

  /** Returns NaN when either vector has zero norm. */
  cosineSimilarity(other: SimdFloat32Vector): number {
    this.#check(other);
    return wasmCosineSimilarity(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#paddedLength,
    );
  }

  addScaled(other: SimdFloat32Vector, scale: number): this {
    this.#check(other);
    axpy(this.#allocation.pointer, other.#allocation.pointer, this.#paddedLength, scale);
    return this;
  }

  toFloat32Array(): Float32Array {
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
}
