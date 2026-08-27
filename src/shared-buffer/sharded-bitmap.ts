export const SHARDED_BITMAP_CACHE_LINE_BYTES = 64;

const BITMAP_MAGIC = 0x5348_424d;
const BITMAP_ABI_VERSION = 1;
const HEADER_WORDS = SHARDED_BITMAP_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const OWNERS_BYTE_OFFSET = SHARDED_BITMAP_CACHE_LINE_BYTES;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const SHARD_COUNT_INDEX = 3;
const WORD_COUNT_INDEX = 4;
const PADDED_WORDS_INDEX = 5;
const SHARD_STRIDE_INDEX = 6;
const DATA_OFFSET_INDEX = 7;
const RESULT_OFFSET_INDEX = 8;
const BYTE_LENGTH_INDEX = 9;
const REDUCTION_GENERATION_INDEX = 10;
const REDUCTION_OWNER_INDEX = 11;

export interface ShardedBitmapOptions {
  readonly capacity: number;
  readonly shardCount: number;
}

export interface ShardedBitmapBuffer {
  readonly workerId: number;
  readonly disposed: boolean;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
  reduceUint32ShardsOr(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void;
  reduceUint32ShardsAnd(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void;
}

export interface ShardedBitmapShard extends Disposable {
  readonly index: number;
  readonly capacity: number;
  readonly disposed: boolean;
  has(bit: number): boolean;
  set(bit: number): void;
  clear(bit: number): void;
  toggle(bit: number): void;
  clearAll(): void;
}

/** A reduction view that remains valid until the next reduction overwrites its storage. */
export interface ShardedBitmapReduction {
  readonly capacity: number;
  readonly generation: number;
  has(bit: number): boolean;
  countOnes(): number;
  wordsInto(output: Uint32Array): number;
}

/** Worker-owned bitmap shards with barrier-delimited SIMD OR/AND reduction. */
export class ShardedBitmap {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly resultByteOffset: number;
  readonly capacity: number;
  readonly shardCount: number;
  readonly wordCount: number;
  readonly paddedWords: number;
  readonly shardStride: number;
  readonly #buffer: ShardedBitmapBuffer;
  readonly #header: Int32Array;
  readonly #owners: Int32Array;

  private constructor(
    buffer: ShardedBitmapBuffer,
    byteOffset: number,
    layout: Layout,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.dataByteOffset = byteOffset + layout.dataOffset;
    this.resultByteOffset = byteOffset + layout.resultOffset;
    this.capacity = layout.capacity;
    this.shardCount = layout.shardCount;
    this.wordCount = layout.wordCount;
    this.paddedWords = layout.paddedWords;
    this.shardStride = layout.shardStride;
    this.#owners = buffer.int32Array(byteOffset + OWNERS_BYTE_OFFSET, layout.shardCount);
  }

  static byteLengthFor(options: ShardedBitmapOptions): number {
    return validateOptions(options).byteLength;
  }

  static initialize(
    buffer: ShardedBitmapBuffer,
    byteOffset: number,
    options: ShardedBitmapOptions,
  ): ShardedBitmap {
    validateByteOffset(byteOffset);
    const layout = validateOptions(options);
    buffer.uint32Array(byteOffset, layout.byteLength / Uint32Array.BYTES_PER_ELEMENT).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, BITMAP_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, layout.capacity);
    Atomics.store(header, SHARD_COUNT_INDEX, layout.shardCount);
    Atomics.store(header, WORD_COUNT_INDEX, layout.wordCount);
    Atomics.store(header, PADDED_WORDS_INDEX, layout.paddedWords);
    Atomics.store(header, SHARD_STRIDE_INDEX, layout.shardStride);
    Atomics.store(header, DATA_OFFSET_INDEX, layout.dataOffset);
    Atomics.store(header, RESULT_OFFSET_INDEX, layout.resultOffset);
    Atomics.store(header, BYTE_LENGTH_INDEX, layout.byteLength);
    Atomics.store(header, MAGIC_INDEX, BITMAP_MAGIC);
    return new ShardedBitmap(buffer, byteOffset, layout, header);
  }

  static attach(buffer: ShardedBitmapBuffer, byteOffset: number): ShardedBitmap {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== BITMAP_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized ShardedBitmap");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== BITMAP_ABI_VERSION) {
      throw new RangeError(`unsupported ShardedBitmap ABI version: ${version}`);
    }
    const layout = validateOptions({
      capacity: Atomics.load(header, CAPACITY_INDEX) >>> 0,
      shardCount: Atomics.load(header, SHARD_COUNT_INDEX) >>> 0,
    });
    if (
      (Atomics.load(header, WORD_COUNT_INDEX) >>> 0) !== layout.wordCount ||
      (Atomics.load(header, PADDED_WORDS_INDEX) >>> 0) !== layout.paddedWords ||
      (Atomics.load(header, SHARD_STRIDE_INDEX) >>> 0) !== layout.shardStride ||
      (Atomics.load(header, DATA_OFFSET_INDEX) >>> 0) !== layout.dataOffset ||
      (Atomics.load(header, RESULT_OFFSET_INDEX) >>> 0) !== layout.resultOffset ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== layout.byteLength
    ) {
      throw new RangeError("invalid ShardedBitmap layout");
    }
    buffer.uint32Array(byteOffset, layout.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    return new ShardedBitmap(buffer, byteOffset, layout, header);
  }

  claimShard(index: number = this.#buffer.workerId): ShardedBitmapShard {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.shardCount) {
      throw new RangeError("shard index out of bounds");
    }
    const owner = this.#buffer.workerId + 1;
    if (Atomics.compareExchange(this.#owners, index, 0, owner) !== 0) {
      throw new RangeError("ShardedBitmap shard is already claimed");
    }
    const words = this.#buffer.uint32Array(
      this.dataByteOffset + index * this.shardStride,
      this.paddedWords,
    );
    return new ShardedBitmapShardLease(
      this.#buffer,
      this.#owners,
      index,
      owner,
      this.capacity,
      words,
    );
  }

  reduceOr(): ShardedBitmapReduction {
    return this.#reduce("or");
  }

  reduceAnd(): ShardedBitmapReduction {
    return this.#reduce("and");
  }

  #reduce(operation: "or" | "and"): ShardedBitmapReduction {
    this.#assertAlive();
    const owner = this.#buffer.workerId + 1;
    if (Atomics.compareExchange(this.#header, REDUCTION_OWNER_INDEX, 0, owner) !== 0) {
      throw new RangeError("ShardedBitmap reduction is already running");
    }
    try {
      const reduce = operation === "or"
        ? this.#buffer.reduceUint32ShardsOr.bind(this.#buffer)
        : this.#buffer.reduceUint32ShardsAnd.bind(this.#buffer);
      reduce(
        this.resultByteOffset,
        this.dataByteOffset,
        this.shardCount,
        this.shardStride,
        this.paddedWords,
      );
      const generation = (Atomics.add(this.#header, REDUCTION_GENERATION_INDEX, 1) + 1) >>> 0;
      const words = this.#buffer.uint32Array(this.resultByteOffset, this.paddedWords);
      return new ShardedBitmapReductionView(
        this.#buffer,
        this.#header,
        generation,
        this.capacity,
        this.wordCount,
        words,
      );
    } finally {
      Atomics.store(this.#header, REDUCTION_OWNER_INDEX, 0);
      Atomics.notify(this.#header, REDUCTION_OWNER_INDEX, 1);
    }
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class ShardedBitmapShardLease implements ShardedBitmapShard {
  readonly index: number;
  readonly capacity: number;
  readonly #buffer: ShardedBitmapBuffer;
  readonly #owners: Int32Array;
  readonly #owner: number;
  readonly #words: Uint32Array;
  #disposed = false;

  constructor(
    buffer: ShardedBitmapBuffer,
    owners: Int32Array,
    index: number,
    owner: number,
    capacity: number,
    words: Uint32Array,
  ) {
    this.#buffer = buffer;
    this.#owners = owners;
    this.index = index;
    this.#owner = owner;
    this.capacity = capacity;
    this.#words = words;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  has(bit: number): boolean {
    const { wordIndex, mask } = this.#locate(bit);
    return (this.#words[wordIndex]! & mask) !== 0;
  }

  set(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    this.#words[wordIndex] = (this.#words[wordIndex]! | mask) >>> 0;
  }

  clear(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    this.#words[wordIndex] = (this.#words[wordIndex]! & ~mask) >>> 0;
  }

  toggle(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    this.#words[wordIndex] = (this.#words[wordIndex]! ^ mask) >>> 0;
  }

  clearAll(): void {
    this.#assertAlive();
    this.#words.fill(0);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Atomics.compareExchange(this.#owners, this.index, this.#owner, 0);
  }

  #locate(bit: number): { readonly wordIndex: number; readonly mask: number } {
    this.#assertAlive();
    if (!Number.isSafeInteger(bit) || bit < 0 || bit >= this.capacity) {
      throw new RangeError("bit out of bounds");
    }
    return { wordIndex: bit >>> 5, mask: 1 << (bit & 31) };
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (this.#disposed || Atomics.load(this.#owners, this.index) !== this.#owner) {
      throw new Error("ShardedBitmap shard lease has been disposed or lost ownership");
    }
  }
}

class ShardedBitmapReductionView implements ShardedBitmapReduction {
  readonly generation: number;
  readonly capacity: number;
  readonly #buffer: ShardedBitmapBuffer;
  readonly #header: Int32Array;
  readonly #wordCount: number;
  readonly #words: Uint32Array;

  constructor(
    buffer: ShardedBitmapBuffer,
    header: Int32Array,
    generation: number,
    capacity: number,
    wordCount: number,
    words: Uint32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.generation = generation;
    this.capacity = capacity;
    this.#wordCount = wordCount;
    this.#words = words;
  }

  has(bit: number): boolean {
    this.#assertCurrent();
    if (!Number.isSafeInteger(bit) || bit < 0 || bit >= this.capacity) {
      throw new RangeError("bit out of bounds");
    }
    return (this.#words[bit >>> 5]! & (1 << (bit & 31))) !== 0;
  }

  countOnes(): number {
    this.#assertCurrent();
    let count = 0;
    for (let index = 0; index < this.#wordCount; index++) {
      let word = this.#words[index]!;
      word -= word >>> 1 & 0x5555_5555;
      word = (word & 0x3333_3333) + (word >>> 2 & 0x3333_3333);
      count += (word + (word >>> 4) & 0x0f0f_0f0f) * 0x0101_0101 >>> 24;
    }
    return count;
  }

  wordsInto(output: Uint32Array): number {
    this.#assertCurrent();
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    if (output.length < this.#wordCount) throw new RangeError("output is too small");
    output.set(this.#words.subarray(0, this.#wordCount));
    return this.#wordCount;
  }

  #assertCurrent(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if ((Atomics.load(this.#header, REDUCTION_GENERATION_INDEX) >>> 0) !== this.generation) {
      throw new Error("ShardedBitmap reduction view is stale");
    }
  }
}

interface Layout {
  readonly capacity: number;
  readonly shardCount: number;
  readonly wordCount: number;
  readonly paddedWords: number;
  readonly shardStride: number;
  readonly dataOffset: number;
  readonly resultOffset: number;
  readonly byteLength: number;
}

function validateOptions(options: ShardedBitmapOptions): Layout {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  const { capacity, shardCount } = options;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0xffff_ffff) {
    throw new RangeError("capacity must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 0x7fff_ffff) {
    throw new RangeError("shardCount must be a positive 32-bit integer");
  }
  const wordCount = Math.ceil(capacity / 32);
  const paddedWords = alignTo(wordCount, 4);
  const shardStride = alignTo(
    Math.max(SHARDED_BITMAP_CACHE_LINE_BYTES, paddedWords * 4),
    SHARDED_BITMAP_CACHE_LINE_BYTES,
  );
  const dataOffset = alignTo(
    OWNERS_BYTE_OFFSET + shardCount * Int32Array.BYTES_PER_ELEMENT,
    SHARDED_BITMAP_CACHE_LINE_BYTES,
  );
  const resultOffset = dataOffset + shardCount * shardStride;
  const byteLength = resultOffset + shardStride;
  if (![dataOffset, resultOffset, byteLength].every(Number.isSafeInteger)) {
    throw new RangeError("ShardedBitmap layout exceeds the safe integer range");
  }
  return {
    capacity,
    shardCount,
    wordCount,
    paddedWords,
    shardStride,
    dataOffset,
    resultOffset,
    byteLength,
  };
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % SHARDED_BITMAP_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${SHARDED_BITMAP_CACHE_LINE_BYTES}-byte aligned`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
