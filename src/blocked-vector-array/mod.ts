import {
  inner_product_many as wasmInnerProductMany,
  l1_distance_many as wasmL1DistanceMany,
  memory,
  squared_distance_many as wasmSquaredDistanceMany,
  top_k as wasmTopK,
  top_k_inner_product as wasmTopKInnerProduct,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const BLOCK_SIZE = 64;
const BYTES_PER_LANE = 4;
const MAX_WASM_BYTES = 0x7fff_ffff;
const allocator = new LinearMemoryAllocator(memory);

type ScoreManyKernel = (
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  output: number,
) => void;

type TopKKernel = (
  vectors: number,
  query: number,
  count: number,
  dimensions: number,
  scratch: number,
  outputIds: number,
  outputScores: number,
  k: number,
) => void;

/**
 * A frozen Float32 matrix stored as 64-row, dimension-major PDX blocks.
 *
 * The layout lets one query dimension update 64 independent distances without
 * horizontal reductions. Construction transposes row-major input once.
 */
export class BlockedVectorArray {
  readonly length: number;
  readonly dimensions: number;
  readonly blockSize = BLOCK_SIZE;
  readonly blockCount: number;
  readonly encodedBytes: number;
  readonly residentBytes: number;
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(values: Float32Array, length: number, dimensions: number) {
    this.length = length;
    this.dimensions = dimensions;
    this.blockCount = Math.ceil(length / BLOCK_SIZE);
    this.encodedBytes = values.byteLength;
    this.residentBytes = checkedResidentBytes(this.blockCount, dimensions);
    const allocation = allocator.allocate(this.residentBytes);
    try {
      const storage = new Float32Array(
        memory.buffer,
        allocation.pointer,
        this.residentBytes / BYTES_PER_LANE,
      );
      for (let row = 0; row < length; row++) {
        const block = row >>> 6;
        const lane = row & (BLOCK_SIZE - 1);
        const inputOffset = row * dimensions;
        const blockOffset = block * dimensions * BLOCK_SIZE;
        for (let dimension = 0; dimension < dimensions; dimension++) {
          storage[blockOffset + dimension * BLOCK_SIZE + lane] = values[inputOffset + dimension]!;
        }
      }
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  static from(
    values: Float32Array,
    length: number,
    dimensions: number,
  ): BlockedVectorArray {
    validateShape(values, length, dimensions);
    return new BlockedVectorArray(values, length, dimensions);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(row: number, dimension: number): number {
    this.#assertAlive();
    this.#validateRow(row);
    if (!Number.isSafeInteger(dimension) || dimension < 0 || dimension >= this.dimensions) {
      throw new RangeError("dimension is out of bounds");
    }
    return this.#storage()[this.#offset(row, dimension)]!;
  }

  rowInto(row: number, output: Float32Array): Float32Array {
    this.#assertAlive();
    this.#validateRow(row);
    if (!(output instanceof Float32Array) || output.length < this.dimensions) {
      throw new RangeError("output must cover every dimension");
    }
    const storage = this.#storage();
    const block = row >>> 6;
    const lane = row & (BLOCK_SIZE - 1);
    const blockOffset = block * this.dimensions * BLOCK_SIZE;
    for (let dimension = 0; dimension < this.dimensions; dimension++) {
      output[dimension] = storage[blockOffset + dimension * BLOCK_SIZE + lane]!;
    }
    return output;
  }

  /** Computes exact squared L2 distance from `query` to every stored row. */
  squaredDistanceMany(query: Float32Array, output: Float32Array): Float32Array {
    return this.#scoreMany(query, output, wasmSquaredDistanceMany);
  }

  /** Computes exact L1 distance from `query` to every stored row. */
  l1DistanceMany(query: Float32Array, output: Float32Array): Float32Array {
    return this.#scoreMany(query, output, wasmL1DistanceMany);
  }

  /** Computes the inner product of `query` and every stored row. */
  innerProductMany(query: Float32Array, output: Float32Array): Float32Array {
    return this.#scoreMany(query, output, wasmInnerProductMany);
  }

  /** Writes the nearest rows ordered by squared distance, then by row ID. */
  topKInto(query: Float32Array, ids: Uint32Array, distances: Float32Array): number {
    return this.#topKInto(query, ids, distances, wasmTopK);
  }

  /** Writes rows ordered by descending inner product, then by row ID. */
  topKInnerProductInto(
    query: Float32Array,
    ids: Uint32Array,
    products: Float32Array,
  ): number {
    return this.#topKInto(query, ids, products, wasmTopKInnerProduct);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #storage(): Float32Array {
    return new Float32Array(
      memory.buffer,
      this.#allocation.pointer,
      this.residentBytes / BYTES_PER_LANE,
    );
  }

  #topKInto(
    query: Float32Array,
    ids: Uint32Array,
    scores: Float32Array,
    kernel: TopKKernel,
  ): number {
    this.#assertAlive();
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query dimensions must match the array");
    }
    if (!(ids instanceof Uint32Array) || !(scores instanceof Float32Array)) {
      throw new TypeError("top-k outputs must be Uint32Array and Float32Array");
    }
    if (ids.length !== scores.length) {
      throw new RangeError("top-k output lengths must match");
    }
    const k = ids.length;
    if (k > this.length) throw new RangeError("top-k output length exceeds the array");
    if (k === 0) return 0;

    const queryBytes = this.dimensions * BYTES_PER_LANE;
    const paddedLength = this.blockCount * BLOCK_SIZE;
    const distanceBytes = paddedLength * BYTES_PER_LANE;
    const outputBytes = k * BYTES_PER_LANE;
    const scratch = allocator.allocate(queryBytes + distanceBytes + outputBytes * 2);
    try {
      const distancePointer = scratch.pointer + queryBytes;
      const idsPointer = distancePointer + distanceBytes;
      const topDistancesPointer = idsPointer + outputBytes;
      new Float32Array(memory.buffer, scratch.pointer, this.dimensions).set(query);
      kernel(
        this.#allocation.pointer,
        scratch.pointer,
        this.length,
        this.dimensions,
        distancePointer,
        idsPointer,
        topDistancesPointer,
        k,
      );
      ids.set(new Uint32Array(memory.buffer, idsPointer, k));
      scores.set(new Float32Array(memory.buffer, topDistancesPointer, k));
      return k;
    } finally {
      allocator.release(scratch);
    }
  }

  #scoreMany(
    query: Float32Array,
    output: Float32Array,
    kernel: ScoreManyKernel,
  ): Float32Array {
    this.#assertAlive();
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query dimensions must match the array");
    }
    if (!(output instanceof Float32Array) || output.length < this.length) {
      throw new RangeError("output must cover every stored vector");
    }
    const queryBytes = this.dimensions * BYTES_PER_LANE;
    const paddedLength = this.blockCount * BLOCK_SIZE;
    const scratch = allocator.allocate(queryBytes + paddedLength * BYTES_PER_LANE);
    try {
      new Float32Array(memory.buffer, scratch.pointer, this.dimensions).set(query);
      kernel(
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

  #offset(row: number, dimension: number): number {
    const block = row >>> 6;
    const lane = row & (BLOCK_SIZE - 1);
    return (block * this.dimensions + dimension) * BLOCK_SIZE + lane;
  }

  #validateRow(row: number): void {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.length) {
      throw new RangeError("row is out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BlockedVectorArray has been disposed");
  }
}

function validateShape(values: Float32Array, length: number, dimensions: number): void {
  if (!(values instanceof Float32Array)) throw new TypeError("values must be a Float32Array");
  if (
    !Number.isSafeInteger(length) || length <= 0 ||
    !Number.isSafeInteger(dimensions) || dimensions <= 0
  ) {
    throw new RangeError("length and dimensions must be positive integers");
  }
  if (values.length !== length * dimensions) {
    throw new RangeError("Float32 shape does not match values");
  }
  checkedResidentBytes(Math.ceil(length / BLOCK_SIZE), dimensions);
}

function checkedResidentBytes(blockCount: number, dimensions: number): number {
  const bytes = blockCount * dimensions * BLOCK_SIZE * BYTES_PER_LANE;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_WASM_BYTES) {
    throw new RangeError("blocked vector storage is too large");
  }
  return bytes;
}
