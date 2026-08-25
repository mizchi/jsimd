import {
  and as wasmAnd,
  and_not as wasmAndNot,
  count as wasmCount,
  intersection_count as wasmIntersectionCount,
  memory,
  or as wasmOr,
  xor as wasmXor,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

class BitSetStorage {
  capacity: number;
  words: number;
  paddedWords: number;
  allocation: Allocation;
  disposed = false;
  readonly typeName: string;

  constructor(capacity: number, typeName: string) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError("invalid capacity");
    this.typeName = typeName;
    this.capacity = capacity;
    this.words = Math.ceil(capacity / 32);
    this.paddedWords = (this.words + 3) & ~3;
    this.allocation = allocator.allocate(this.paddedWords * 4);
  }

  assertAlive(): void {
    if (this.disposed) throw new Error(`${this.typeName} has been disposed`);
  }

  view(): Uint32Array {
    this.assertAlive();
    return new Uint32Array(memory.buffer, this.allocation.pointer, this.paddedWords);
  }

  resize(capacity: number): void {
    this.assertAlive();
    if (capacity <= this.capacity) return;
    if (!Number.isSafeInteger(capacity)) throw new RangeError("invalid capacity");

    const words = Math.ceil(capacity / 32);
    const paddedWords = (words + 3) & ~3;
    const allocation = allocator.allocate(paddedWords * 4);
    new Uint32Array(memory.buffer, allocation.pointer, paddedWords).set(
      new Uint32Array(memory.buffer, this.allocation.pointer, this.paddedWords),
    );
    allocator.release(this.allocation);
    this.capacity = capacity;
    this.words = words;
    this.paddedWords = paddedWords;
    this.allocation = allocation;
  }

  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    allocator.release(this.allocation);
  }
}

function insert(storage: BitSetStorage, bit: number): void {
  const words = storage.view();
  words[bit >>> 5] = (words[bit >>> 5]! | (1 << (bit & 31))) >>> 0;
}

function remove(storage: BitSetStorage, bit: number): void {
  const words = storage.view();
  words[bit >>> 5] = (words[bit >>> 5]! & ~(1 << (bit & 31))) >>> 0;
}

function has(storage: BitSetStorage, bit: number): boolean {
  return (storage.view()[bit >>> 5]! & (1 << (bit & 31))) !== 0;
}

function toArray(storage: BitSetStorage): number[] {
  const result: number[] = [];
  const words = storage.view();
  for (let wordIndex = 0; wordIndex < storage.words; wordIndex++) {
    let word = words[wordIndex]!;
    while (word !== 0) {
      const lowest = word & -word;
      result.push((wordIndex << 5) + 31 - Math.clz32(lowest));
      word = (word & (word - 1)) >>> 0;
    }
  }
  return result;
}

/** A fixed-universe dense bit set. Operations between sets require identical capacities. */
export class FixedBitSet {
  readonly capacity: number;
  readonly #storage: BitSetStorage;

  constructor(capacity: number) {
    this.#storage = new BitSetStorage(capacity, "FixedBitSet");
    this.capacity = capacity;
  }

  static from(capacity: number, bits: Iterable<number>): FixedBitSet {
    const result = new FixedBitSet(capacity);
    try {
      for (const bit of bits) result.insert(bit);
      return result;
    } catch (error) {
      result[Symbol.dispose]();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  #checkBit(bit: number): void {
    this.#storage.assertAlive();
    if (!Number.isSafeInteger(bit) || bit < 0 || bit >= this.capacity) {
      throw new RangeError("bit out of bounds");
    }
  }

  #checkOther(other: FixedBitSet): void {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    if (this.capacity !== other.capacity) throw new RangeError("bitset capacities must match");
  }

  insert(bit: number): this {
    this.#checkBit(bit);
    insert(this.#storage, bit);
    return this;
  }

  remove(bit: number): this {
    this.#checkBit(bit);
    remove(this.#storage, bit);
    return this;
  }

  has(bit: number): boolean {
    this.#checkBit(bit);
    return has(this.#storage, bit);
  }

  clear(): this {
    this.#storage.view().fill(0);
    return this;
  }

  clone(): FixedBitSet {
    const result = new FixedBitSet(this.capacity);
    result.#storage.view().set(this.#storage.view());
    return result;
  }

  unionWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmOr(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      this.#storage.paddedWords,
    );
    return this;
  }

  intersectWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmAnd(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      this.#storage.paddedWords,
    );
    return this;
  }

  differenceWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmAndNot(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      this.#storage.paddedWords,
    );
    return this;
  }

  symmetricDifferenceWith(other: FixedBitSet): this {
    this.#checkOther(other);
    wasmXor(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      this.#storage.paddedWords,
    );
    return this;
  }

  countOnes(): number {
    this.#storage.assertAlive();
    return wasmCount(this.#storage.allocation.pointer, this.#storage.paddedWords);
  }

  intersectionCount(other: FixedBitSet): number {
    this.#checkOther(other);
    return wasmIntersectionCount(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.paddedWords,
    );
  }

  isDisjoint(other: FixedBitSet): boolean {
    return this.intersectionCount(other) === 0;
  }

  toArray(): number[] {
    return toArray(this.#storage);
  }

  dispose(): void {
    this.#storage.release();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A growable dense bit set. Growth happens only on insertion, outside SIMD bulk operations. */
export class BitSet {
  readonly #storage: BitSetStorage;

  constructor(initialCapacity = 0) {
    this.#storage = new BitSetStorage(initialCapacity, "BitSet");
  }

  static from(bits: Iterable<number>): BitSet {
    const result = new BitSet();
    try {
      for (const bit of bits) result.insert(bit);
      return result;
    } catch (error) {
      result[Symbol.dispose]();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get capacity(): number {
    this.#storage.assertAlive();
    return this.#storage.capacity;
  }

  #checkBit(bit: number): void {
    this.#storage.assertAlive();
    if (!Number.isSafeInteger(bit) || bit < 0) throw new RangeError("invalid bit index");
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#storage.capacity) return;
    const doubled = this.#storage.capacity <= Number.MAX_SAFE_INTEGER / 2
      ? this.#storage.capacity * 2
      : required;
    this.#storage.resize(Math.max(128, doubled, required));
  }

  insert(bit: number): this {
    this.#checkBit(bit);
    this.#ensureCapacity(bit + 1);
    insert(this.#storage, bit);
    return this;
  }

  remove(bit: number): this {
    this.#checkBit(bit);
    if (bit < this.#storage.capacity) remove(this.#storage, bit);
    return this;
  }

  has(bit: number): boolean {
    this.#checkBit(bit);
    return bit < this.#storage.capacity && has(this.#storage, bit);
  }

  clear(): this {
    this.#storage.view().fill(0);
    return this;
  }

  clone(): BitSet {
    const result = new BitSet(this.#storage.capacity);
    result.#storage.view().set(this.#storage.view());
    return result;
  }

  unionWith(other: BitSet): this {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    this.#ensureCapacity(other.#storage.capacity);
    wasmOr(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      other.#storage.paddedWords,
    );
    return this;
  }

  intersectWith(other: BitSet): this {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    const commonWords = Math.min(this.#storage.paddedWords, other.#storage.paddedWords);
    wasmAnd(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      commonWords,
    );
    this.#storage.view().subarray(commonWords).fill(0);
    return this;
  }

  differenceWith(other: BitSet): this {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    const commonWords = Math.min(this.#storage.paddedWords, other.#storage.paddedWords);
    wasmAndNot(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      commonWords,
    );
    return this;
  }

  symmetricDifferenceWith(other: BitSet): this {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    this.#ensureCapacity(other.#storage.capacity);
    wasmXor(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      this.#storage.allocation.pointer,
      other.#storage.paddedWords,
    );
    return this;
  }

  countOnes(): number {
    this.#storage.assertAlive();
    return wasmCount(this.#storage.allocation.pointer, this.#storage.paddedWords);
  }

  intersectionCount(other: BitSet): number {
    this.#storage.assertAlive();
    other.#storage.assertAlive();
    return wasmIntersectionCount(
      this.#storage.allocation.pointer,
      other.#storage.allocation.pointer,
      Math.min(this.#storage.paddedWords, other.#storage.paddedWords),
    );
  }

  isDisjoint(other: BitSet): boolean {
    return this.intersectionCount(other) === 0;
  }

  toArray(): number[] {
    return toArray(this.#storage);
  }

  dispose(): void {
    this.#storage.release();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
