import {
  add_many as wasmAddMany,
  may_contain_many as wasmMayContainMany,
  memory,
  merge as wasmMerge,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const BITS_PER_BLOCK = 128;
const MAX_ALLOCATION_BYTES = 0x4000_0000;
const allocator = new LinearMemoryAllocator(memory);

/** A mutable 128-bit-blocked Bloom filter specialized for bulk Uint32 queries. */
export class BlockedBloomFilterU32 {
  readonly expectedItems: number;
  readonly blockCount: number;
  readonly byteLength: number;
  readonly bitsPerKey: number;
  readonly hashCount = 4;
  readonly #allocation: Allocation;
  #disposed = false;

  constructor(expectedItems: number, targetBitsPerKey = 10) {
    validateNonNegative(expectedItems, "expectedItems");
    if (!Number.isFinite(targetBitsPerKey) || targetBitsPerKey < 1 || targetBitsPerKey > 128) {
      throw new RangeError("targetBitsPerKey must be between 1 and 128");
    }
    const blockCount = Math.max(
      1,
      Math.ceil(expectedItems * targetBitsPerKey / BITS_PER_BLOCK),
    );
    const byteLength = blockCount * 16;
    if (byteLength > MAX_ALLOCATION_BYTES) {
      throw new RangeError("Bloom filter exceeds the supported Wasm allocation size");
    }
    this.expectedItems = expectedItems;
    this.blockCount = blockCount;
    this.byteLength = byteLength;
    this.bitsPerKey = expectedItems === 0
      ? Number.POSITIVE_INFINITY
      : this.blockCount * BITS_PER_BLOCK / expectedItems;
    this.#allocation = allocator.allocate(this.byteLength);
  }

  static from(keys: Uint32Array, targetBitsPerKey = 10): BlockedBloomFilterU32 {
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    const filter = new BlockedBloomFilterU32(keys.length, targetBitsPerKey);
    try {
      filter.addMany(keys);
      return filter;
    } catch (error) {
      filter.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  addMany(keys: Uint32Array): this {
    this.#assertAlive();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (keys.length === 0) return this;
    const scratch = allocator.allocate(keys.byteLength);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      wasmAddMany(this.#allocation.pointer, this.blockCount, scratch.pointer, keys.length);
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  mayContainMany(keys: Uint32Array, output: Uint8Array): number {
    this.#assertAlive();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (!(output instanceof Uint8Array) || output.length < keys.length) {
      throw new RangeError("output must cover every query key");
    }
    if (keys.length === 0) return 0;
    const scratch = allocator.allocate(keys.byteLength + keys.length);
    const outputPointer = scratch.pointer + keys.byteLength;
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const count = wasmMayContainMany(
        this.#allocation.pointer,
        this.blockCount,
        scratch.pointer,
        outputPointer,
        keys.length,
      );
      output.set(new Uint8Array(memory.buffer, outputPointer, keys.length), 0);
      return count;
    } finally {
      allocator.release(scratch);
    }
  }

  merge(other: BlockedBloomFilterU32): this {
    this.#assertAlive();
    other.#assertAlive();
    if (this.blockCount !== other.blockCount) {
      throw new RangeError("Bloom filter block counts must match");
    }
    wasmMerge(this.#allocation.pointer, other.#allocation.pointer, this.blockCount);
    return this;
  }

  clear(): this {
    this.#assertAlive();
    new Uint8Array(memory.buffer, this.#allocation.pointer, this.byteLength).fill(0);
    return this;
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
    if (this.#disposed) throw new Error("BlockedBloomFilterU32 has been disposed");
  }
}

function validateNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fff_ffff) {
    throw new RangeError(`${name} must be a non-negative Wasm-addressable integer`);
  }
}
