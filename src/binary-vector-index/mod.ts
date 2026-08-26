import {
  distance_many as wasmDistanceMany,
  memory,
  pdx_distance_many as wasmPdxDistanceMany,
  pdx_distance_selected as wasmPdxDistanceSelected,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";
import {
  decodeSnapshot,
  encodeSnapshot,
  expectPayloadBytes,
  invalidSnapshot,
  SnapshotKind,
} from "../internal/snapshot.ts";

const allocator = new LinearMemoryAllocator(memory);

type BinaryVectorSource =
  | {
    readonly signatures: readonly Uint8Array[];
    readonly byteLength: number;
    readonly dimensions: number;
  }
  | {
    readonly storage: Uint8Array;
    readonly length: number;
    readonly byteLength: number;
    readonly dimensions: number;
  };

/** A frozen row-major index for exact Hamming search over fixed-width binary signatures. */
export class BinaryVectorIndex {
  readonly length: number;
  readonly dimensions: number;
  readonly encodedBytes: number;
  readonly #byteLength: number;
  readonly #stride: number;
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(source: BinaryVectorSource) {
    this.length = "storage" in source ? source.length : source.signatures.length;
    this.#byteLength = source.byteLength;
    this.dimensions = source.dimensions;
    this.#stride = (source.byteLength + 15) & ~15;
    this.encodedBytes = this.length * source.byteLength;
    const allocation = allocator.allocate(this.length * this.#stride);
    try {
      const storage = new Uint8Array(memory.buffer, allocation.pointer, allocation.byteLength);
      if ("storage" in source) {
        storage.set(source.storage);
      } else {
        for (let index = 0; index < source.signatures.length; index++) {
          storage.set(source.signatures[index]!, index * this.#stride);
        }
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
    return new BinaryVectorIndex({ signatures, byteLength, dimensions: byteLength * 8 });
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
    return new BinaryVectorIndex({ signatures, byteLength, dimensions });
  }

  static fromSnapshot(snapshot: Uint8Array): BinaryVectorIndex {
    const { shape, payloads } = decodeSnapshot(
      snapshot,
      SnapshotKind.BinaryVectorIndex,
      3,
      1,
    );
    const length = shape[0]!;
    const dimensions = shape[1]!;
    const byteLength = shape[2]!;
    if (length === 0 || dimensions === 0 || byteLength !== Math.ceil(dimensions / 8)) {
      throw invalidSnapshot("invalid binary vector shape");
    }
    const stride = (byteLength + 15) & ~15;
    const residentBytes = length * stride;
    if (!Number.isSafeInteger(residentBytes) || residentBytes > 0x7fff_ffff) {
      throw invalidSnapshot("binary vector storage is too large");
    }
    const storage = payloads[0]!;
    expectPayloadBytes(storage, residentBytes, "binary vector storage");
    const tailBits = dimensions & 7;
    const tailMask = tailBits === 0 ? 0xff : (1 << tailBits) - 1;
    for (let row = 0; row < length; row++) {
      const offset = row * stride;
      if ((storage[offset + byteLength - 1]! & ~tailMask) !== 0) {
        throw invalidSnapshot("set bits outside binary vector dimensions");
      }
      for (let byte = byteLength; byte < stride; byte++) {
        if (storage[offset + byte] !== 0) {
          throw invalidSnapshot("non-zero binary vector padding");
        }
      }
    }
    return new BinaryVectorIndex({ storage, length, byteLength, dimensions });
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  serialize(): Uint8Array {
    this.#assertAlive();
    return encodeSnapshot(
      SnapshotKind.BinaryVectorIndex,
      [this.length, this.dimensions, this.#byteLength],
      [
        new Uint8Array(
          memory.buffer,
          this.#allocation.pointer,
          this.length * this.#stride,
        ),
      ],
    );
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

/** Exact Float32 squared-L2 index with four candidates interleaved per PDX block. */
export class PdxFloat32Index {
  readonly length: number;
  readonly dimensions: number;
  readonly encodedBytes: number;
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(values: Float32Array, count: number, dimensions: number) {
    this.length = count;
    this.dimensions = dimensions;
    this.encodedBytes = values.byteLength;
    const blocks = Math.ceil(count / 4);
    const allocation = allocator.allocate(blocks * dimensions * 16);
    try {
      const storage = new Float32Array(
        memory.buffer,
        allocation.pointer,
        blocks * dimensions * 4,
      );
      for (let row = 0; row < count; row++) {
        const lane = row & 3;
        const block = row >>> 2;
        for (let dimension = 0; dimension < dimensions; dimension++) {
          storage[(block * dimensions + dimension) * 4 + lane] =
            values[row * dimensions + dimension]!;
        }
      }
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  static from(values: Float32Array, count: number, dimensions: number): PdxFloat32Index {
    validateFloat32Shape(values, count, dimensions);
    return new PdxFloat32Index(values, count, dimensions);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  distanceMany(query: Float32Array, output: Float32Array): Float32Array {
    this.#assertAlive();
    this.#validateQuery(query);
    if (!(output instanceof Float32Array) || output.length < this.length) {
      throw new RangeError("output must cover every indexed vector");
    }
    const queryBytes = this.dimensions * 4;
    const paddedCount = (this.length + 3) & ~3;
    const scratch = allocator.allocate(queryBytes + paddedCount * 4);
    try {
      new Float32Array(memory.buffer, scratch.pointer, this.dimensions).set(query);
      wasmPdxDistanceMany(
        this.#allocation.pointer,
        scratch.pointer,
        this.length,
        this.dimensions,
        scratch.pointer + queryBytes,
      );
      output.set(
        new Float32Array(memory.buffer, scratch.pointer + queryBytes, this.length),
      );
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  distanceSelected(
    query: Float32Array,
    ids: Uint32Array,
    output: Float32Array,
  ): Float32Array {
    this.#assertAlive();
    this.#validateQuery(query);
    if (!(ids instanceof Uint32Array)) throw new TypeError("ids must be a Uint32Array");
    if (!(output instanceof Float32Array) || output.length < ids.length) {
      throw new RangeError("output must cover every selected vector");
    }
    for (const id of ids) {
      if (id >= this.length) throw new RangeError("selected vector ID out of bounds");
    }
    const queryBytes = this.dimensions * 4;
    const idsOffset = queryBytes;
    const outputOffset = idsOffset + ids.byteLength;
    const paddedCount = (ids.length + 3) & ~3;
    const scratch = allocator.allocate(outputOffset + paddedCount * 4);
    try {
      new Float32Array(memory.buffer, scratch.pointer, this.dimensions).set(query);
      new Uint32Array(memory.buffer, scratch.pointer + idsOffset, ids.length).set(ids);
      wasmPdxDistanceSelected(
        this.#allocation.pointer,
        scratch.pointer,
        scratch.pointer + idsOffset,
        ids.length,
        this.dimensions,
        scratch.pointer + outputOffset,
      );
      output.set(
        new Float32Array(memory.buffer, scratch.pointer + outputOffset, ids.length),
      );
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #validateQuery(query: Float32Array): void {
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query dimensions must match the index");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("PdxFloat32Index has been disposed");
  }
}

/** Binary candidate search followed by exact PDX Float32 reranking. */
export class BinaryVectorIndexWithRerank {
  readonly length: number;
  readonly dimensions: number;
  readonly encodedBytes: number;
  readonly threshold: number;
  readonly #binary: BinaryVectorIndex;
  readonly #exact: PdxFloat32Index;
  #disposed = false;

  private constructor(
    binary: BinaryVectorIndex,
    exact: PdxFloat32Index,
    threshold: number,
  ) {
    this.#binary = binary;
    this.#exact = exact;
    this.length = binary.length;
    this.dimensions = binary.dimensions;
    this.encodedBytes = binary.encodedBytes + exact.encodedBytes;
    this.threshold = threshold;
  }

  static fromFloat32(
    values: Float32Array,
    count: number,
    dimensions: number,
    threshold = 0,
  ): BinaryVectorIndexWithRerank {
    validateFloat32Shape(values, count, dimensions);
    if (!Number.isFinite(threshold)) throw new RangeError("threshold must be finite");
    const binary = BinaryVectorIndex.fromFloat32(values, count, dimensions, threshold);
    try {
      return new BinaryVectorIndexWithRerank(
        binary,
        PdxFloat32Index.from(values, count, dimensions),
        threshold,
      );
    } catch (error) {
      binary.dispose();
      throw error;
    }
  }

  /**
   * Searches `candidateCount` binary neighbors and reranks them by exact
   * squared L2 distance. Returns at most `k` results.
   */
  topK(
    query: Float32Array,
    k: number,
    candidateCount: number,
    ids: Uint32Array,
    distances: Float32Array,
  ): number {
    this.#assertAlive();
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query dimensions must match the index");
    }
    if (!Number.isSafeInteger(k) || k < 0) throw new RangeError("k must be non-negative");
    if (!Number.isSafeInteger(candidateCount) || candidateCount < k) {
      throw new RangeError("candidateCount must be an integer at least k");
    }
    const resultCount = Math.min(k, this.length);
    if (ids.length < resultCount || distances.length < resultCount) {
      throw new RangeError("top-k outputs are too small");
    }
    const candidates = Math.min(candidateCount, this.length);
    const candidateIds = new Uint32Array(candidates);
    const hamming = new Uint32Array(candidates);
    this.#binary.topK(quantizeQuery(query, this.threshold), candidates, candidateIds, hamming);
    const exactDistances = new Float32Array(candidates);
    this.#exact.distanceSelected(query, candidateIds, exactDistances);
    const order = Uint32Array.from({ length: candidates }, (_, index) => index);
    order.sort((left, right) =>
      exactDistances[left]! - exactDistances[right]! || candidateIds[left]! - candidateIds[right]!
    );
    for (let index = 0; index < resultCount; index++) {
      const selected = order[index]!;
      ids[index] = candidateIds[selected]!;
      distances[index] = exactDistances[selected]!;
    }
    return resultCount;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exact.dispose();
    this.#binary.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BinaryVectorIndexWithRerank has been disposed");
  }
}

function validateFloat32Shape(values: Float32Array, count: number, dimensions: number): void {
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
}

function quantizeQuery(query: Float32Array, threshold: number): Uint8Array {
  const signature = new Uint8Array(Math.ceil(query.length / 8));
  for (let dimension = 0; dimension < query.length; dimension++) {
    if (query[dimension]! > threshold) signature[dimension >>> 3] |= 1 << (dimension & 7);
  }
  return signature;
}
