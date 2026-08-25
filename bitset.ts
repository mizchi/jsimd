import {
  and as wasmAnd,
  and_not as wasmAndNot,
  count as wasmCount,
  intersection_count as wasmIntersectionCount,
  memory,
  or as wasmOr,
  xor as wasmXor,
} from "./dist/bitset.wasm";
import { type Allocation, type AllocatorStats, LinearMemoryAllocator } from "./src/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

export class FixedBitSet {
  readonly capacity: number;
  readonly #allocation: Allocation;
  readonly #words: number;
  readonly #paddedWords: number;
  #disposed = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError("invalid capacity");
    this.capacity = capacity;
    this.#words = Math.ceil(capacity / 32);
    this.#paddedWords = (this.#words + 3) & ~3;
    this.#allocation = allocator.allocate(this.#paddedWords * 4);
  }

  static from(capacity: number, bits: Iterable<number>): FixedBitSet {
    const result = new FixedBitSet(capacity);
    for (const bit of bits) result.insert(bit);
    return result;
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FixedBitSet has been disposed");
  }

  #view(): Uint32Array {
    this.#assertAlive();
    return new Uint32Array(memory.buffer, this.#allocation.pointer, this.#paddedWords);
  }

  #checkBit(bit: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(bit) || bit < 0 || bit >= this.capacity) {
      throw new RangeError("bit out of bounds");
    }
  }

  #checkOther(other: FixedBitSet): void {
    this.#assertAlive();
    other.#assertAlive();
    if (this.capacity !== other.capacity) throw new RangeError("bitset capacities must match");
  }

  insert(bit: number): this {
    this.#checkBit(bit);
    const words = this.#view();
    words[bit >>> 5] = (words[bit >>> 5]! | (1 << (bit & 31))) >>> 0;
    return this;
  }

  remove(bit: number): this {
    this.#checkBit(bit);
    const words = this.#view();
    words[bit >>> 5] = (words[bit >>> 5]! & ~(1 << (bit & 31))) >>> 0;
    return this;
  }

  has(bit: number): boolean {
    this.#checkBit(bit);
    return (this.#view()[bit >>> 5]! & (1 << (bit & 31))) !== 0;
  }

  clear(): this {
    this.#view().fill(0);
    return this;
  }

  clone(): FixedBitSet {
    const result = new FixedBitSet(this.capacity);
    result.#view().set(this.#view());
    return result;
  }

  unionWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmOr(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#allocation.pointer,
      this.#paddedWords,
    );
    return this;
  }

  intersectWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmAnd(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#allocation.pointer,
      this.#paddedWords,
    );
    return this;
  }

  differenceWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmAndNot(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#allocation.pointer,
      this.#paddedWords,
    );
    return this;
  }

  symmetricDifferenceWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmXor(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#allocation.pointer,
      this.#paddedWords,
    );
    return this;
  }

  countOnes(): number {
    this.#assertAlive();
    return wasmCount(this.#allocation.pointer, this.#paddedWords);
  }

  intersectionCount(other: FixedBitSet): number {
    this.#checkOther(other);
    return wasmIntersectionCount(
      this.#allocation.pointer,
      other.#allocation.pointer,
      this.#paddedWords,
    );
  }

  isDisjoint(other: FixedBitSet): boolean {
    return this.intersectionCount(other) === 0;
  }

  toArray(): number[] {
    const result: number[] = [];
    const words = this.#view();
    for (let wordIndex = 0; wordIndex < this.#words; wordIndex++) {
      let word = words[wordIndex]!;
      while (word !== 0) {
        const lowest = word & -word;
        result.push((wordIndex << 5) + 31 - Math.clz32(lowest));
        word = (word & (word - 1)) >>> 0;
      }
    }
    return result;
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
