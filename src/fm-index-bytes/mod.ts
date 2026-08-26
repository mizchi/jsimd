import {
  build as wasmBuild,
  count as wasmCount,
  count_many as wasmCountMany,
  locate_many as wasmLocateMany,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const LEVELS = 8;
const ALPHABET_SIZE = 256;
const SAMPLE_RATE = 32;
const allocator = new LinearMemoryAllocator(memory);

/** A frozen FM-index over arbitrary bytes, optimized for repeated batched occurrence counts. */
export class FmIndexBytes {
  readonly length: number;
  readonly sentinelRow: number;
  readonly #paddedWords: number;
  readonly #superblocks: number;
  readonly #bits: Allocation;
  readonly #ranks: Allocation;
  readonly #zeros: Allocation;
  readonly #cumulative: Allocation;
  readonly #sampleBits: Allocation;
  readonly #sampleRanks: Allocation;
  readonly #sampleValues: Allocation;
  #disposed = false;

  private constructor(text: Uint8Array) {
    if (!(text instanceof Uint8Array)) throw new TypeError("text must be a Uint8Array");
    if (text.length > 0x7fff_fffe) throw new RangeError("text is too large");
    this.length = text.length;
    const transformedLength = text.length + 1;
    const words = Math.ceil(transformedLength / 32);
    this.#paddedWords = Math.ceil(words / 4) * 4;
    this.#superblocks = Math.ceil(this.#paddedWords / 16);

    const { bwt, cumulative, sentinelRow, sampleBits, sampleRanks, sampleValues } = buildBwt(
      text,
      this.#paddedWords,
      this.#superblocks,
    );
    this.sentinelRow = sentinelRow;
    let bits: Allocation | undefined;
    let ranks: Allocation | undefined;
    let zeros: Allocation | undefined;
    let cumulativeAllocation: Allocation | undefined;
    let sampleBitsAllocation: Allocation | undefined;
    let sampleRanksAllocation: Allocation | undefined;
    let sampleValuesAllocation: Allocation | undefined;
    let scratch: Allocation | undefined;
    try {
      bits = allocator.allocate(LEVELS * this.#paddedWords * 4);
      ranks = allocator.allocate(LEVELS * (this.#superblocks + 1) * 4);
      zeros = allocator.allocate(LEVELS * 4);
      cumulativeAllocation = allocator.allocate(ALPHABET_SIZE * 4);
      sampleBitsAllocation = allocator.allocate(sampleBits.byteLength);
      sampleRanksAllocation = allocator.allocate(sampleRanks.byteLength);
      sampleValuesAllocation = allocator.allocate(sampleValues.byteLength);
      scratch = allocator.allocate(transformedLength * 8);
      new Uint32Array(memory.buffer, scratch.pointer, transformedLength).set(bwt);
      new Uint32Array(memory.buffer, cumulativeAllocation.pointer, ALPHABET_SIZE).set(cumulative);
      new Uint32Array(memory.buffer, sampleBitsAllocation.pointer, sampleBits.length).set(
        sampleBits,
      );
      new Uint32Array(memory.buffer, sampleRanksAllocation.pointer, sampleRanks.length).set(
        sampleRanks,
      );
      new Uint32Array(memory.buffer, sampleValuesAllocation.pointer, sampleValues.length).set(
        sampleValues,
      );
      wasmBuild(
        scratch.pointer,
        scratch.pointer + transformedLength * 4,
        bits.pointer,
        ranks.pointer,
        zeros.pointer,
        transformedLength,
        this.#paddedWords,
        this.#superblocks,
      );
    } catch (error) {
      if (scratch !== undefined) allocator.release(scratch);
      if (sampleValuesAllocation !== undefined) allocator.release(sampleValuesAllocation);
      if (sampleRanksAllocation !== undefined) allocator.release(sampleRanksAllocation);
      if (sampleBitsAllocation !== undefined) allocator.release(sampleBitsAllocation);
      if (cumulativeAllocation !== undefined) allocator.release(cumulativeAllocation);
      if (zeros !== undefined) allocator.release(zeros);
      if (ranks !== undefined) allocator.release(ranks);
      if (bits !== undefined) allocator.release(bits);
      throw error;
    }
    allocator.release(scratch);
    this.#bits = bits;
    this.#ranks = ranks;
    this.#zeros = zeros;
    this.#cumulative = cumulativeAllocation;
    this.#sampleBits = sampleBitsAllocation;
    this.#sampleRanks = sampleRanksAllocation;
    this.#sampleValues = sampleValuesAllocation;
  }

  static from(text: Uint8Array): FmIndexBytes {
    return new FmIndexBytes(text);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get encodedBytes(): number {
    return LEVELS * (this.#paddedWords + this.#superblocks + 2) * 4 + ALPHABET_SIZE * 4 +
      this.#sampleBits.byteLength + this.#sampleRanks.byteLength + this.#sampleValues.byteLength;
  }

  get sampleRate(): number {
    return SAMPLE_RATE;
  }

  count(pattern: Uint8Array): number {
    this.#assertAlive();
    if (!(pattern instanceof Uint8Array)) throw new TypeError("pattern must be a Uint8Array");
    const scratch = allocator.allocate(pattern.length);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, pattern.length).set(pattern);
      return wasmCount(...this.#queryBase(), scratch.pointer, pattern.length);
    } finally {
      allocator.release(scratch);
    }
  }

  has(pattern: Uint8Array): boolean {
    return this.count(pattern) !== 0;
  }

  countMany(
    patterns: Uint8Array,
    offsets: Uint32Array,
    output: Uint32Array = new Uint32Array(offsets.length - 1),
  ): Uint32Array {
    this.#assertAlive();
    const count = validateBatch(patterns, offsets);
    if (!(output instanceof Uint32Array) || output.length !== count) {
      throw new RangeError("output length must match the pattern count");
    }
    if (count === 0) return output;
    const offsetsOffset = align4(patterns.byteLength);
    const outputOffset = offsetsOffset + offsets.byteLength;
    const scratch = allocator.allocate(outputOffset + output.byteLength);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, patterns.length).set(patterns);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, offsets.length).set(offsets);
      wasmCountMany(
        ...this.#queryBase(),
        scratch.pointer,
        scratch.pointer + offsetsOffset,
        count,
        scratch.pointer + outputOffset,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer + outputOffset, count));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  locate(pattern: Uint8Array): Uint32Array {
    if (!(pattern instanceof Uint8Array)) throw new TypeError("pattern must be a Uint8Array");
    return this.locateMany(pattern, Uint32Array.of(0, pattern.length)).positions;
  }

  locateMany(
    patterns: Uint8Array,
    offsets: Uint32Array,
  ): { readonly offsets: Uint32Array; readonly positions: Uint32Array } {
    this.#assertAlive();
    const queryCount = validateBatch(patterns, offsets);
    const counts = this.countMany(patterns, offsets);
    const resultOffsets = new Uint32Array(queryCount + 1);
    let total = 0;
    for (let query = 0; query < queryCount; query++) {
      total += counts[query]!;
      if (total > 0xffff_ffff) throw new RangeError("located result is too large");
      resultOffsets[query + 1] = total;
    }
    const positions = new Uint32Array(total);
    if (queryCount === 0 || total === 0) return { offsets: resultOffsets, positions };
    const offsetsOffset = align4(patterns.byteLength);
    const resultOffsetsOffset = offsetsOffset + offsets.byteLength;
    const outputOffset = resultOffsetsOffset + resultOffsets.byteLength;
    const scratch = allocator.allocate(outputOffset + positions.byteLength);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, patterns.length).set(patterns);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, offsets.length).set(offsets);
      new Uint32Array(
        memory.buffer,
        scratch.pointer + resultOffsetsOffset,
        resultOffsets.length,
      ).set(resultOffsets);
      wasmLocateMany(
        ...this.#queryBase(),
        this.#sampleBits.pointer,
        this.#sampleRanks.pointer,
        this.#sampleValues.pointer,
        scratch.pointer,
        scratch.pointer + offsetsOffset,
        queryCount,
        scratch.pointer + resultOffsetsOffset,
        scratch.pointer + outputOffset,
      );
      positions.set(new Uint32Array(memory.buffer, scratch.pointer + outputOffset, total));
      return { offsets: resultOffsets, positions };
    } finally {
      allocator.release(scratch);
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#sampleValues);
    allocator.release(this.#sampleRanks);
    allocator.release(this.#sampleBits);
    allocator.release(this.#cumulative);
    allocator.release(this.#zeros);
    allocator.release(this.#ranks);
    allocator.release(this.#bits);
  }

  #queryBase(): [number, number, number, number, number, number, number, number] {
    return [
      this.#bits.pointer,
      this.#ranks.pointer,
      this.#zeros.pointer,
      this.#paddedWords,
      this.#superblocks,
      this.#cumulative.pointer,
      this.sentinelRow,
      this.length,
    ];
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FmIndexBytes has been disposed");
  }
}

function buildBwt(
  text: Uint8Array,
  paddedWords: number,
  superblocks: number,
): {
  bwt: Uint32Array;
  cumulative: Uint32Array;
  sentinelRow: number;
  sampleBits: Uint32Array;
  sampleRanks: Uint32Array;
  sampleValues: Uint32Array;
} {
  const length = text.length + 1;
  const suffixes = Array.from({ length }, (_, index) => index);
  let ranks = Int32Array.from(
    { length },
    (_, index) => index === text.length ? 0 : text[index]! + 1,
  );
  let nextRanks = new Int32Array(length);
  for (let width = 1; width < length; width *= 2) {
    suffixes.sort((left, right) => {
      const first = ranks[left]! - ranks[right]!;
      if (first !== 0) return first;
      const leftSecond = left + width < length ? ranks[left + width]! : -1;
      const rightSecond = right + width < length ? ranks[right + width]! : -1;
      return leftSecond - rightSecond;
    });
    nextRanks[suffixes[0]!] = 0;
    for (let index = 1; index < length; index++) {
      const previous = suffixes[index - 1]!;
      const current = suffixes[index]!;
      const differs = ranks[previous] !== ranks[current] ||
        (previous + width < length ? ranks[previous + width] : -1) !==
          (current + width < length ? ranks[current + width] : -1);
      nextRanks[current] = nextRanks[previous]! + Number(differs);
    }
    [ranks, nextRanks] = [nextRanks, ranks];
    if (ranks[suffixes[length - 1]!] === length - 1) break;
  }

  const bwt = new Uint32Array(length);
  const sampleBits = new Uint32Array(paddedWords);
  const sampled: number[] = [];
  let sentinelRow = -1;
  for (let row = 0; row < length; row++) {
    const suffix = suffixes[row]!;
    if (suffix % SAMPLE_RATE === 0) {
      sampleBits[row >>> 5] |= 1 << (row & 31);
      sampled.push(suffix);
    }
    if (suffix === 0) {
      sentinelRow = row;
      bwt[row] = 0;
    } else {
      bwt[row] = text[suffix - 1]!;
    }
  }
  const counts = new Uint32Array(ALPHABET_SIZE);
  for (const byte of text) counts[byte]++;
  const cumulative = new Uint32Array(ALPHABET_SIZE);
  let total = 1;
  for (let byte = 0; byte < ALPHABET_SIZE; byte++) {
    cumulative[byte] = total;
    total += counts[byte]!;
  }
  const sampleRanks = new Uint32Array(superblocks + 1);
  let rank = 0;
  for (let superblock = 0; superblock < superblocks; superblock++) {
    sampleRanks[superblock] = rank;
    const end = Math.min((superblock + 1) * 16, paddedWords);
    for (let word = superblock * 16; word < end; word++) rank += popcount32(sampleBits[word]!);
  }
  sampleRanks[superblocks] = rank;
  return {
    bwt,
    cumulative,
    sentinelRow,
    sampleBits,
    sampleRanks,
    sampleValues: Uint32Array.from(sampled),
  };
}

function popcount32(value: number): number {
  value -= (value >>> 1) & 0x5555_5555;
  value = (value & 0x3333_3333) + ((value >>> 2) & 0x3333_3333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}

function validateBatch(patterns: Uint8Array, offsets: Uint32Array): number {
  if (!(patterns instanceof Uint8Array)) throw new TypeError("patterns must be a Uint8Array");
  if (!(offsets instanceof Uint32Array) || offsets.length === 0 || offsets[0] !== 0) {
    throw new RangeError("offsets must start with zero");
  }
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index]! < offsets[index - 1]!) throw new RangeError("offsets must be monotone");
  }
  if (offsets[offsets.length - 1] !== patterns.length) {
    throw new RangeError("the final offset must equal patterns.length");
  }
  return offsets.length - 1;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}
