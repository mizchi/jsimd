import {
  at as wasmAt,
  at_many as wasmAtMany,
  build_rank_index as wasmBuildRankIndex,
  decode_into as wasmDecodeInto,
  lower_bound as wasmLowerBound,
  lower_bound_many as wasmLowerBoundMany,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const UINT32_LIMIT = 0x1_0000_0000;
const allocator = new LinearMemoryAllocator(memory);

interface EncodedEliasFano {
  readonly highWords: Uint32Array;
  readonly lowWords: Uint32Array;
  readonly highLength: number;
  readonly zeroCount: number;
  readonly lowerBits: number;
  readonly length: number;
}

/** Mutable non-decreasing construction state for an immutable Elias-Fano snapshot. */
export class EliasFanoSequenceBuilder {
  readonly #values: number[] = [];

  get length(): number {
    return this.#values.length;
  }

  append(value: number): this {
    const normalized = validateUint32(value);
    const previous = this.#values[this.#values.length - 1];
    if (previous !== undefined && normalized < previous) {
      throw new RangeError("values must be non-decreasing");
    }
    this.#values.push(normalized);
    return this;
  }

  freeze(): EliasFanoSequence {
    return EliasFanoSequence.fromUint32Array(Uint32Array.from(this.#values));
  }
}

/** A frozen Elias-Fano sequence supporting random access and ordered queries without decoding. */
export class EliasFanoSequence {
  readonly length: number;
  readonly lowerBits: number;
  readonly encodedBytes: number;
  readonly #highLength: number;
  readonly #zeroCount: number;
  readonly #paddedWords: number;
  readonly #superblocks: number;
  readonly #highAllocation: Allocation;
  readonly #rankAllocation: Allocation;
  readonly #lowAllocation: Allocation;
  #disposed = false;

  private constructor(encoded: EncodedEliasFano) {
    this.length = encoded.length;
    this.lowerBits = encoded.lowerBits;
    this.#highLength = encoded.highLength;
    this.#zeroCount = encoded.zeroCount;
    this.#paddedWords = (encoded.highWords.length + 3) & ~3;
    this.#superblocks = Math.ceil(this.#paddedWords / 16);
    this.encodedBytes = encoded.highWords.byteLength + encoded.lowWords.byteLength +
      (this.#superblocks + 1) * 4;

    let highAllocation: Allocation | undefined;
    let rankAllocation: Allocation | undefined;
    let lowAllocation: Allocation | undefined;
    try {
      highAllocation = allocator.allocate(this.#paddedWords * 4);
      rankAllocation = allocator.allocate((this.#superblocks + 1) * 4);
      lowAllocation = allocator.allocate(encoded.lowWords.byteLength);
      new Uint32Array(memory.buffer, highAllocation.pointer, this.#paddedWords).set(
        encoded.highWords,
      );
      new Uint32Array(memory.buffer, lowAllocation.pointer, encoded.lowWords.length).set(
        encoded.lowWords,
      );
      const count = wasmBuildRankIndex(
        highAllocation.pointer,
        rankAllocation.pointer,
        this.#paddedWords,
        this.#superblocks,
      );
      if (count !== this.length) throw new Error("invalid Elias-Fano high-bit encoding");
    } catch (error) {
      if (lowAllocation !== undefined) allocator.release(lowAllocation);
      if (rankAllocation !== undefined) allocator.release(rankAllocation);
      if (highAllocation !== undefined) allocator.release(highAllocation);
      throw error;
    }
    this.#highAllocation = highAllocation;
    this.#rankAllocation = rankAllocation;
    this.#lowAllocation = lowAllocation;
  }

  static from(values: Iterable<number>): EliasFanoSequence {
    const builder = new EliasFanoSequenceBuilder();
    for (const value of values) builder.append(value);
    return builder.freeze();
  }

  static fromUint32Array(values: Uint32Array): EliasFanoSequence {
    validateLength(values.length);
    for (let index = 1; index < values.length; index++) {
      if (values[index]! < values[index - 1]!) {
        throw new RangeError("values must be non-decreasing");
      }
    }
    return new EliasFanoSequence(encode(values));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  at(index: number): number {
    this.#checkIndex(index);
    return wasmAt(...this.#accessBase(), index) >>> 0;
  }

  /** Returns the number of stored values strictly less than `value`. */
  rank(value: number): number {
    this.#assertAlive();
    validateBound(value);
    if (value === UINT32_LIMIT) return this.length;
    return wasmLowerBound(...this.#orderedBase(), value);
  }

  nextGEQ(value: number): number {
    const index = this.rank(value);
    return index === this.length ? -1 : this.at(index);
  }

  /** Returns the largest stored value strictly less than `value`, or -1. */
  predecessor(value: number): number {
    const index = this.rank(value);
    return index === 0 ? -1 : this.at(index - 1);
  }

  atMany(
    indices: Uint32Array,
    output: Uint32Array = new Uint32Array(indices.length),
  ): Uint32Array {
    this.#assertAlive();
    if (output.length !== indices.length) throw new RangeError("output length must match queries");
    for (const index of indices) this.#checkIndex(index);
    const scratch = allocator.allocate(indices.byteLength * 2);
    try {
      const outputPointer = scratch.pointer + indices.byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, indices.length).set(indices);
      wasmAtMany(...this.#accessBase(), scratch.pointer, outputPointer, indices.length);
      output.set(new Uint32Array(memory.buffer, outputPointer, output.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  rankMany(
    values: Uint32Array,
    output: Uint32Array = new Uint32Array(values.length),
  ): Uint32Array {
    this.#assertAlive();
    if (output.length !== values.length) throw new RangeError("output length must match queries");
    const scratch = allocator.allocate(values.byteLength * 2);
    try {
      const outputPointer = scratch.pointer + values.byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, values.length).set(values);
      wasmLowerBoundMany(...this.#orderedBase(), scratch.pointer, outputPointer, values.length);
      output.set(new Uint32Array(memory.buffer, outputPointer, output.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  toUint32Array(): Uint32Array {
    const output = new Uint32Array(this.length);
    return this.decodeInto(output);
  }

  decodeInto(output: Uint32Array): Uint32Array {
    this.#assertAlive();
    if (output.length < this.length) throw new RangeError("output is too small");
    if (this.length === 0) return output;
    const scratch = allocator.allocate(this.length * 4);
    try {
      wasmDecodeInto(
        this.#highAllocation.pointer,
        this.#lowAllocation.pointer,
        this.lowerBits,
        this.length,
        scratch.pointer,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer, this.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#lowAllocation);
    allocator.release(this.#rankAllocation);
    allocator.release(this.#highAllocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #accessBase(): [number, number, number, number, number, number] {
    this.#assertAlive();
    return [
      this.#highAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#lowAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
      this.lowerBits,
    ];
  }

  #orderedBase(): [number, number, number, number, number, number, number, number, number] {
    this.#assertAlive();
    return [
      this.#highAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#lowAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
      this.#highLength,
      this.length,
      this.lowerBits,
      this.#zeroCount,
    ];
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("EliasFanoSequence has been disposed");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("index out of bounds");
    }
  }
}

interface PartitionedPage {
  readonly base: number;
  readonly maximum: number;
  readonly length: number;
  readonly sequence?: EliasFanoSequence;
}

export interface PartitionedEliasFanoEncodingCounts {
  readonly contiguous: number;
  readonly eliasFano: number;
}

/** Mutable construction state for a partitioned Elias-Fano snapshot. */
export class PartitionedEliasFanoSequenceBuilder {
  readonly blockSize: number;
  readonly #values: number[] = [];

  constructor(blockSize = 256) {
    this.blockSize = validateBlockSize(blockSize);
  }

  get length(): number {
    return this.#values.length;
  }

  append(value: number): this {
    const normalized = validateUint32(value);
    const previous = this.#values[this.#values.length - 1];
    if (previous !== undefined && normalized < previous) {
      throw new RangeError("values must be non-decreasing");
    }
    this.#values.push(normalized);
    return this;
  }

  freeze(): PartitionedEliasFanoSequence {
    return PartitionedEliasFanoSequence.fromUint32Array(
      Uint32Array.from(this.#values),
      this.blockSize,
    );
  }
}

/**
 * A monotone sequence that chooses a zero-payload contiguous page or a local
 * Elias-Fano encoding for each block.
 */
export class PartitionedEliasFanoSequence {
  readonly length: number;
  readonly blockSize: number;
  readonly blockCount: number;
  readonly encodedBytes: number;
  readonly #pages: readonly PartitionedPage[];
  #disposed = false;

  private constructor(
    length: number,
    blockSize: number,
    pages: readonly PartitionedPage[],
  ) {
    this.length = length;
    this.blockSize = blockSize;
    this.blockCount = pages.length;
    this.#pages = pages;
    this.encodedBytes = pages.length * 16 + pages.reduce(
      (bytes, page) => bytes + (page.sequence?.encodedBytes ?? 0),
      0,
    );
  }

  static from(values: Iterable<number>, blockSize = 256): PartitionedEliasFanoSequence {
    const builder = new PartitionedEliasFanoSequenceBuilder(blockSize);
    for (const value of values) builder.append(value);
    return builder.freeze();
  }

  static fromUint32Array(
    values: Uint32Array,
    blockSize = 256,
  ): PartitionedEliasFanoSequence {
    validateLength(values.length);
    const normalizedBlockSize = validateBlockSize(blockSize);
    for (let index = 1; index < values.length; index++) {
      if (values[index]! < values[index - 1]!) {
        throw new RangeError("values must be non-decreasing");
      }
    }
    const pages: PartitionedPage[] = [];
    try {
      for (let offset = 0; offset < values.length; offset += normalizedBlockSize) {
        const pageValues = values.subarray(
          offset,
          Math.min(values.length, offset + normalizedBlockSize),
        );
        const base = pageValues[0]!;
        const maximum = pageValues[pageValues.length - 1]!;
        let contiguous = true;
        for (let index = 1; index < pageValues.length; index++) {
          if (pageValues[index] !== base + index) {
            contiguous = false;
            break;
          }
        }
        if (contiguous) {
          pages.push({ base, maximum, length: pageValues.length });
          continue;
        }
        const local = Uint32Array.from(pageValues, (value) => value - base);
        pages.push({
          base,
          maximum,
          length: pageValues.length,
          sequence: EliasFanoSequence.fromUint32Array(local),
        });
      }
      return new PartitionedEliasFanoSequence(values.length, normalizedBlockSize, pages);
    } catch (error) {
      for (const page of pages) page.sequence?.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  at(index: number): number {
    this.#checkIndex(index);
    const pageIndex = Math.floor(index / this.blockSize);
    const page = this.#pages[pageIndex]!;
    const localIndex = index - pageIndex * this.blockSize;
    return page.base + (page.sequence?.at(localIndex) ?? localIndex);
  }

  /** Returns the number of stored values strictly less than `value`. */
  rank(value: number): number {
    this.#assertAlive();
    validateBound(value);
    let low = 0;
    let high = this.#pages.length;
    while (low < high) {
      const middle = low + ((high - low) >>> 1);
      if (this.#pages[middle]!.maximum < value) low = middle + 1;
      else high = middle;
    }
    if (low === this.#pages.length) return this.length;
    const page = this.#pages[low]!;
    const prefix = low * this.blockSize;
    if (value <= page.base) return prefix;
    if (page.sequence === undefined) {
      return prefix + Math.min(page.length, value - page.base);
    }
    return prefix + page.sequence.rank(value - page.base);
  }

  nextGEQ(value: number): number {
    const index = this.rank(value);
    return index === this.length ? -1 : this.at(index);
  }

  predecessor(value: number): number {
    const index = this.rank(value);
    return index === 0 ? -1 : this.at(index - 1);
  }

  encodingCounts(): PartitionedEliasFanoEncodingCounts {
    this.#assertAlive();
    let contiguous = 0;
    let eliasFano = 0;
    for (const page of this.#pages) {
      if (page.sequence === undefined) contiguous++;
      else eliasFano++;
    }
    return Object.freeze({ contiguous, eliasFano });
  }

  decodeInto(output: Uint32Array): Uint32Array {
    this.#assertAlive();
    if (output.length < this.length) throw new RangeError("output is too small");
    let offset = 0;
    for (const page of this.#pages) {
      const target = output.subarray(offset, offset + page.length);
      if (page.sequence === undefined) {
        for (let index = 0; index < page.length; index++) target[index] = page.base + index;
      } else {
        page.sequence.decodeInto(target);
        for (let index = 0; index < page.length; index++) {
          target[index] = page.base + target[index]!;
        }
      }
      offset += page.length;
    }
    return output;
  }

  toUint32Array(): Uint32Array {
    return this.decodeInto(new Uint32Array(this.length));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const page of this.#pages) page.sequence?.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("PartitionedEliasFanoSequence has been disposed");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("index out of bounds");
    }
  }
}

function encode(values: Uint32Array): EncodedEliasFano {
  if (values.length === 0) {
    return {
      highWords: new Uint32Array(),
      lowWords: new Uint32Array(),
      highLength: 0,
      zeroCount: 0,
      lowerBits: 0,
      length: 0,
    };
  }

  const universe = values[values.length - 1]! + 1;
  const ratio = universe / values.length;
  const lowerBits = ratio <= 1 ? 0 : Math.min(32, Math.floor(Math.log2(ratio)));
  const divisor = 2 ** lowerBits;
  const zeroCount = Math.floor(universe / divisor);
  const highLength = zeroCount + values.length;
  if (!Number.isSafeInteger(highLength) || highLength > 0x7fff_ffff) {
    throw new RangeError("encoded high-bit vector is too large");
  }

  const highWords = new Uint32Array(Math.ceil(highLength / 32));
  const lowBitLength = values.length * lowerBits;
  if (!Number.isSafeInteger(lowBitLength) || lowBitLength > 0x7fff_ffff * 8) {
    throw new RangeError("encoded low-bit vector is too large");
  }
  const lowWords = new Uint32Array(Math.ceil(lowBitLength / 32));

  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    const high = Math.floor(value / divisor);
    const highPosition = high + index;
    const highWord = Math.floor(highPosition / 32);
    highWords[highWord] = (highWords[highWord]! | (1 << (highPosition % 32))) >>> 0;

    if (lowerBits === 0) continue;
    const low = value % divisor;
    if (lowerBits === 32) {
      lowWords[index] = low;
      continue;
    }
    const offset = index * lowerBits;
    const lowWord = Math.floor(offset / 32);
    const shift = offset % 32;
    lowWords[lowWord] = (lowWords[lowWord]! | (low << shift)) >>> 0;
    if (shift + lowerBits > 32) {
      lowWords[lowWord + 1] = (lowWords[lowWord + 1]! | (low >>> (32 - shift))) >>> 0;
    }
  }

  return { highWords, lowWords, highLength, zeroCount, lowerBits, length: values.length };
}

function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0x7fff_ffff) {
    throw new RangeError("invalid length");
  }
}

function validateBlockSize(blockSize: number): number {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 0x10000) {
    throw new RangeError("block size must be between 1 and 65536");
  }
  return blockSize;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_LIMIT) {
    throw new RangeError("value must be a Uint32");
  }
  return value;
}

function validateBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_LIMIT) {
    throw new RangeError("value must be in [0, 2^32]");
  }
}
