import {
  build_rank_index as wasmBuildRankIndex,
  memory,
  next1 as wasmNext1,
  prev1 as wasmPrev1,
  rank1 as wasmRank1,
  rank1_many as wasmRank1Many,
  select1 as wasmSelect1,
  select1_many as wasmSelect1Many,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

/** Mutable construction state for an immutable BitVector snapshot. */
export class BitVectorBuilder {
  readonly capacity: number;
  readonly #words: Uint32Array;

  constructor(capacity: number) {
    validateCapacity(capacity);
    this.capacity = capacity;
    this.#words = new Uint32Array(Math.ceil(capacity / 32));
  }

  insert(position: number): this {
    this.#checkPosition(position);
    this.#words[position >>> 5] = (this.#words[position >>> 5]! | (1 << (position & 31))) >>> 0;
    return this;
  }

  remove(position: number): this {
    this.#checkPosition(position);
    this.#words[position >>> 5] = (this.#words[position >>> 5]! & ~(1 << (position & 31))) >>> 0;
    return this;
  }

  has(position: number): boolean {
    this.#checkPosition(position);
    return (this.#words[position >>> 5]! & (1 << (position & 31))) !== 0;
  }

  clear(): this {
    this.#words.fill(0);
    return this;
  }

  freeze(): BitVector {
    return BitVector.fromUint32Array(this.capacity, this.#words);
  }

  #checkPosition(position: number): void {
    if (!Number.isSafeInteger(position) || position < 0 || position >= this.capacity) {
      throw new RangeError("bit position out of bounds");
    }
  }
}

/** An immutable bit vector with a 512-bit rank index and zero-based select queries. */
export class BitVector {
  readonly length: number;
  readonly countOnes: number;
  readonly #words: number;
  readonly #paddedWords: number;
  readonly #superblocks: number;
  readonly #bitsAllocation: Allocation;
  readonly #rankAllocation: Allocation;
  #disposed = false;

  private constructor(capacity: number, words: Uint32Array) {
    validateCapacity(capacity);
    this.length = capacity;
    this.#words = Math.ceil(capacity / 32);
    if (words.length !== this.#words) throw new RangeError("word length must match capacity");
    this.#paddedWords = (this.#words + 3) & ~3;
    this.#superblocks = Math.ceil(this.#paddedWords / 16);
    this.#bitsAllocation = allocator.allocate(this.#paddedWords * 4);
    try {
      this.#rankAllocation = allocator.allocate((this.#superblocks + 1) * 4);
    } catch (error) {
      allocator.release(this.#bitsAllocation);
      throw error;
    }
    try {
      new Uint32Array(
        memory.buffer,
        this.#bitsAllocation.pointer,
        this.#paddedWords,
      ).set(words);
      this.#maskTail();
      this.countOnes = wasmBuildRankIndex(
        this.#bitsAllocation.pointer,
        this.#rankAllocation.pointer,
        this.#paddedWords,
        this.#superblocks,
      );
    } catch (error) {
      allocator.release(this.#rankAllocation);
      allocator.release(this.#bitsAllocation);
      throw error;
    }
  }

  static from(capacity: number, positions: Iterable<number>): BitVector {
    const builder = new BitVectorBuilder(capacity);
    for (const position of positions) builder.insert(position);
    return builder.freeze();
  }

  static fromUint32Array(capacity: number, words: Uint32Array): BitVector {
    return new BitVector(capacity, words);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(position: number): boolean {
    this.#checkPosition(position);
    return (this.#bitsView()[position >>> 5]! & (1 << (position & 31))) !== 0;
  }

  rank1(end: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(end) || end < 0 || end > this.length) {
      throw new RangeError("rank end out of bounds");
    }
    return wasmRank1(this.#bitsAllocation.pointer, this.#rankAllocation.pointer, end);
  }

  rank0(end: number): number {
    return end - this.rank1(end);
  }

  rank1Many(
    ends: Uint32Array,
    output: Uint32Array = new Uint32Array(ends.length),
  ): Uint32Array {
    this.#assertAlive();
    if (output.length !== ends.length) throw new RangeError("output length must match queries");
    for (const end of ends) {
      if (end > this.length) throw new RangeError("rank end out of bounds");
    }
    const scratch = allocator.allocate(ends.byteLength * 2);
    try {
      const outputPointer = scratch.pointer + ends.byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, ends.length).set(ends);
      wasmRank1Many(
        this.#bitsAllocation.pointer,
        this.#rankAllocation.pointer,
        scratch.pointer,
        outputPointer,
        ends.length,
      );
      output.set(new Uint32Array(memory.buffer, outputPointer, ends.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  select1(rank: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(rank) || rank < 0 || rank >= this.countOnes) return -1;
    return wasmSelect1(
      this.#bitsAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
      rank,
    );
  }

  select1Many(
    ranks: Uint32Array,
    output: Int32Array = new Int32Array(ranks.length),
  ): Int32Array {
    this.#assertAlive();
    if (output.length !== ranks.length) throw new RangeError("output length must match queries");
    const scratch = allocator.allocate(ranks.byteLength * 2);
    try {
      const outputPointer = scratch.pointer + ranks.byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, ranks.length).set(ranks);
      wasmSelect1Many(
        this.#bitsAllocation.pointer,
        this.#rankAllocation.pointer,
        this.#paddedWords,
        this.#superblocks,
        scratch.pointer,
        outputPointer,
        ranks.length,
      );
      output.set(new Int32Array(memory.buffer, outputPointer, ranks.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  next1(position: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(position)) throw new RangeError("invalid bit position");
    return wasmNext1(
      this.#bitsAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
      this.countOnes,
      this.length,
      position,
    );
  }

  prev1(position: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(position)) throw new RangeError("invalid bit position");
    return wasmPrev1(
      this.#bitsAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
      this.countOnes,
      this.length,
      position,
    );
  }

  toArray(): number[] {
    const result: number[] = [];
    const words = this.#bitsView();
    for (let wordIndex = 0; wordIndex < this.#words; wordIndex++) {
      let word = words[wordIndex]!;
      while (word !== 0) {
        const lowest = word & -word;
        result.push(wordIndex * 32 + 31 - Math.clz32(lowest));
        word = (word & (word - 1)) >>> 0;
      }
    }
    return result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#rankAllocation);
    allocator.release(this.#bitsAllocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitVector has been disposed");
  }

  #checkPosition(position: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(position) || position < 0 || position >= this.length) {
      throw new RangeError("bit position out of bounds");
    }
  }

  #bitsView(): Uint32Array {
    this.#assertAlive();
    return new Uint32Array(memory.buffer, this.#bitsAllocation.pointer, this.#paddedWords);
  }

  #maskTail(): void {
    const remaining = this.length & 31;
    if (remaining === 0 || this.#words === 0) return;
    const words = this.#bitsView();
    words[this.#words - 1] &= 0xffff_ffff >>> (32 - remaining);
  }
}

function validateCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0x7fff_ffff) {
    throw new RangeError("invalid capacity");
  }
}
