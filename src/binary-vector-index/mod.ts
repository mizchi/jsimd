import { distance_many as wasmDistanceMany, memory } from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** A frozen row-major index for exact Hamming search over fixed-width binary signatures. */
export class BinaryVectorIndex {
  readonly length: number;
  readonly dimensions: number;
  readonly encodedBytes: number;
  readonly #byteLength: number;
  readonly #stride: number;
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(signatures: readonly Uint8Array[], byteLength: number, dimensions: number) {
    this.length = signatures.length;
    this.#byteLength = byteLength;
    this.dimensions = dimensions;
    this.#stride = (byteLength + 15) & ~15;
    this.encodedBytes = signatures.length * byteLength;
    const allocation = allocator.allocate(signatures.length * this.#stride);
    try {
      const storage = new Uint8Array(memory.buffer, allocation.pointer, allocation.byteLength);
      for (let index = 0; index < signatures.length; index++) {
        storage.set(signatures[index]!, index * this.#stride);
      }
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  static fromSignatures(signatures: readonly Uint8Array[]): BinaryVectorIndex {
    if (!Array.isArray(signatures) || signatures.length === 0) {
      throw new RangeError("at least one binary signature is required");
    }
    const byteLength = signatures[0]!.length;
    if (byteLength === 0) throw new RangeError("binary signatures must not be empty");
    for (const signature of signatures) {
      if (!(signature instanceof Uint8Array) || signature.length !== byteLength) {
        throw new RangeError("binary signatures must be equal-length Uint8Arrays");
      }
    }
    return new BinaryVectorIndex(signatures, byteLength, byteLength * 8);
  }

  /** Quantizes each Float32 lane to one bit using `value > threshold`. */
  static fromFloat32(
    values: Float32Array,
    count: number,
    dimensions: number,
    threshold = 0,
  ): BinaryVectorIndex {
    if (!(values instanceof Float32Array)) throw new TypeError("values must be a Float32Array");
    if (
      !Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(dimensions) ||
      dimensions <= 0
    ) {
      throw new RangeError("count and dimensions must be positive integers");
    }
    if (values.length !== count * dimensions) {
      throw new RangeError("Float32 shape does not match values");
    }
    if (!Number.isFinite(threshold)) throw new RangeError("threshold must be finite");
    const byteLength = Math.ceil(dimensions / 8);
    const signatures = Array.from({ length: count }, () => new Uint8Array(byteLength));
    for (let row = 0; row < count; row++) {
      for (let dimension = 0; dimension < dimensions; dimension++) {
        if (values[row * dimensions + dimension]! > threshold) {
          signatures[row]![dimension >>> 3] |= 1 << (dimension & 7);
        }
      }
    }
    return new BinaryVectorIndex(signatures, byteLength, dimensions);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  distanceMany(query: Uint8Array, output: Uint32Array): Uint32Array {
    this.#assertAlive();
    this.#validateQuery(query);
    if (!(output instanceof Uint32Array) || output.length < this.length) {
      throw new RangeError("output must cover every indexed vector");
    }
    const outputOffset = this.#stride;
    const scratch = allocator.allocate(outputOffset + this.length * 4);
    try {
      const paddedQuery = new Uint8Array(memory.buffer, scratch.pointer, this.#stride);
      paddedQuery.set(query);
      const tailBits = this.dimensions & 7;
      if (tailBits !== 0) paddedQuery[this.#byteLength - 1] &= (1 << tailBits) - 1;
      wasmDistanceMany(
        this.#allocation.pointer,
        scratch.pointer,
        this.length,
        this.#stride,
        scratch.pointer + outputOffset,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer + outputOffset, this.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  topK(query: Uint8Array, k: number, ids: Uint32Array, distances: Uint32Array): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(k) || k < 0) throw new RangeError("k must be a non-negative integer");
    const count = Math.min(k, this.length);
    if (ids.length < count || distances.length < count) {
      throw new RangeError("top-k outputs are too small");
    }
    const all = new Uint32Array(this.length);
    this.distanceMany(query, all);
    const order = Uint32Array.from({ length: this.length }, (_, index) => index);
    order.sort((left, right) => all[left]! - all[right]! || left - right);
    for (let index = 0; index < count; index++) {
      ids[index] = order[index]!;
      distances[index] = all[order[index]!]!;
    }
    return count;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #validateQuery(query: Uint8Array): void {
    if (!(query instanceof Uint8Array) || query.length !== this.#byteLength) {
      throw new RangeError("query width must match indexed signatures");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BinaryVectorIndex has been disposed");
  }
}
