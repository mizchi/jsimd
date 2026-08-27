const CACHE_LINE_BYTES = 64;
const HEADER_WORDS = CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const MAGIC = 0x5345_4c4d;
const ABI_VERSION = 1;
const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const WORD_COUNT_INDEX = 3;
const PADDED_WORDS_INDEX = 4;
const DATA_OFFSET_INDEX = 5;
const BYTE_LENGTH_INDEX = 6;
const GENERATION_INDEX = 7;
const WRITER_OWNER_INDEX = 8;
const LAST_GENERATION_INDEX = 9;
const MAX_GENERATION = 0x7fff_ffff;

export interface SharedSelectionMaskBuffer {
  readonly byteLength: number;
  readonly disposed: boolean;
  readonly leaseToken: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
  isLeaseTokenActive(leaseToken: number): boolean;
}

export interface SharedSelectionMaskWriter extends Disposable {
  readonly capacity: number;
  readonly dataByteOffset: number;
  readonly paddedWords: number;
  readonly disposed: boolean;
  clearAll(): void;
  fillAll(): void;
  set(bit: number): void;
  clear(bit: number): void;
  publish(): number;
}

export interface SharedSelectionMaskView {
  readonly capacity: number;
  readonly generation: number;
  readonly dataByteOffset: number;
  readonly paddedWords: number;
  has(bit: number): boolean;
  countOnes(): number;
}

/**
 * Experimental generation-checked bitmap shared between physical operators.
 *
 * One owner writes the mask, publishes a generation, and downstream Workers consume the packed
 * words directly from shared Wasm memory. Publication/task synchronization must ensure that no
 * writer mutates a generation while a kernel reads it; this type deliberately does not provide a
 * concurrent mutable snapshot contract.
 */
export class SharedSelectionMask {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly wordCount: number;
  readonly paddedWords: number;
  readonly #buffer: SharedSelectionMaskBuffer;
  readonly #header: Int32Array;
  readonly #words: Uint32Array;

  private constructor(
    buffer: SharedSelectionMaskBuffer,
    byteOffset: number,
    layout: Layout,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.dataByteOffset = byteOffset + layout.dataOffset;
    this.capacity = layout.capacity;
    this.wordCount = layout.wordCount;
    this.paddedWords = layout.paddedWords;
    this.#words = buffer.uint32Array(this.dataByteOffset, layout.paddedWords);
  }

  static byteLengthFor(capacity: number): number {
    return layoutFor(capacity).byteLength;
  }

  static initialize(
    buffer: SharedSelectionMaskBuffer,
    byteOffset: number,
    capacity: number,
  ): SharedSelectionMask {
    validateByteOffset(byteOffset);
    const layout = layoutFor(capacity);
    buffer.uint32Array(byteOffset, layout.byteLength / 4).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, layout.capacity);
    Atomics.store(header, WORD_COUNT_INDEX, layout.wordCount);
    Atomics.store(header, PADDED_WORDS_INDEX, layout.paddedWords);
    Atomics.store(header, DATA_OFFSET_INDEX, layout.dataOffset);
    Atomics.store(header, BYTE_LENGTH_INDEX, layout.byteLength);
    Atomics.store(header, GENERATION_INDEX, 0);
    Atomics.store(header, WRITER_OWNER_INDEX, 0);
    Atomics.store(header, LAST_GENERATION_INDEX, 0);
    Atomics.store(header, MAGIC_INDEX, MAGIC);
    return new SharedSelectionMask(buffer, byteOffset, layout, header);
  }

  static attach(buffer: SharedSelectionMaskBuffer, byteOffset: number): SharedSelectionMask {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== MAGIC) {
      throw new RangeError("shared memory does not contain an initialized SharedSelectionMask");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== ABI_VERSION) {
      throw new RangeError(`unsupported SharedSelectionMask ABI version: ${version}`);
    }
    const layout = layoutFor(Atomics.load(header, CAPACITY_INDEX) >>> 0);
    if (
      (Atomics.load(header, WORD_COUNT_INDEX) >>> 0) !== layout.wordCount ||
      (Atomics.load(header, PADDED_WORDS_INDEX) >>> 0) !== layout.paddedWords ||
      (Atomics.load(header, DATA_OFFSET_INDEX) >>> 0) !== layout.dataOffset ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== layout.byteLength
    ) {
      throw new RangeError("invalid SharedSelectionMask layout");
    }
    buffer.uint32Array(byteOffset, layout.byteLength / 4);
    return new SharedSelectionMask(buffer, byteOffset, layout, header);
  }

  claimWriter(): SharedSelectionMaskWriter {
    this.#assertAlive();
    const owner = this.#buffer.leaseToken;
    for (;;) {
      const current = Atomics.load(this.#header, WRITER_OWNER_INDEX);
      if (current === owner || current !== 0 && this.#buffer.isLeaseTokenActive(current)) {
        throw new RangeError("SharedSelectionMask writer is already claimed");
      }
      if (Atomics.compareExchange(this.#header, WRITER_OWNER_INDEX, current, owner) === current) {
        return new SharedSelectionMaskWriterLease(
          this.#buffer,
          this.#header,
          this.#words,
          owner,
          this.capacity,
          this.wordCount,
          this.paddedWords,
          this.dataByteOffset,
        );
      }
    }
  }

  read(generation: number): SharedSelectionMaskView {
    this.#assertAlive();
    validateGeneration(generation);
    if ((Atomics.load(this.#header, GENERATION_INDEX) >>> 0) !== generation) {
      throw new Error("SharedSelectionMask generation is not published or is stale");
    }
    return new SharedSelectionMaskGenerationView(
      this.#buffer,
      this.#header,
      this.#words,
      this.capacity,
      this.wordCount,
      this.paddedWords,
      this.dataByteOffset,
      generation,
    );
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class SharedSelectionMaskWriterLease implements SharedSelectionMaskWriter {
  readonly capacity: number;
  readonly dataByteOffset: number;
  readonly paddedWords: number;
  readonly #buffer: SharedSelectionMaskBuffer;
  readonly #header: Int32Array;
  readonly #words: Uint32Array;
  readonly #owner: number;
  readonly #wordCount: number;
  #lastGeneration: number;
  #dirty = false;
  #disposed = false;

  constructor(
    buffer: SharedSelectionMaskBuffer,
    header: Int32Array,
    words: Uint32Array,
    owner: number,
    capacity: number,
    wordCount: number,
    paddedWords: number,
    dataByteOffset: number,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.#words = words;
    this.#owner = owner;
    this.capacity = capacity;
    this.#wordCount = wordCount;
    this.paddedWords = paddedWords;
    this.dataByteOffset = dataByteOffset;
    this.#lastGeneration = Atomics.load(header, LAST_GENERATION_INDEX) >>> 0;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  clearAll(): void {
    this.#beginMutation();
    this.#words.fill(0);
  }

  fillAll(): void {
    this.#beginMutation();
    this.#words.fill(0xffff_ffff, 0, this.#wordCount);
    this.#trimTail();
  }

  set(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    this.#beginMutation();
    this.#words[wordIndex] = (this.#words[wordIndex]! | mask) >>> 0;
  }

  clear(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    this.#beginMutation();
    this.#words[wordIndex] = (this.#words[wordIndex]! & ~mask) >>> 0;
  }

  publish(): number {
    this.#assertAlive();
    if (!this.#dirty) this.#beginMutation();
    this.#trimTail();
    this.#words.fill(0, this.#wordCount);
    this.#lastGeneration = nextGeneration(this.#lastGeneration);
    Atomics.store(this.#header, LAST_GENERATION_INDEX, this.#lastGeneration);
    Atomics.store(this.#header, GENERATION_INDEX, this.#lastGeneration);
    Atomics.notify(this.#header, GENERATION_INDEX);
    this.#dirty = false;
    return this.#lastGeneration;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Atomics.compareExchange(this.#header, WRITER_OWNER_INDEX, this.#owner, 0);
    Atomics.notify(this.#header, WRITER_OWNER_INDEX, 1);
  }

  #locate(bit: number): { readonly wordIndex: number; readonly mask: number } {
    this.#assertAlive();
    if (!Number.isSafeInteger(bit) || bit < 0 || bit >= this.capacity) {
      throw new RangeError("bit out of bounds");
    }
    return { wordIndex: bit >>> 5, mask: 1 << (bit & 31) };
  }

  #beginMutation(): void {
    this.#assertAlive();
    if (this.#dirty) return;
    Atomics.store(this.#header, GENERATION_INDEX, 0);
    this.#dirty = true;
  }

  #trimTail(): void {
    if (this.#wordCount === 0) return;
    const tailBits = this.capacity & 31;
    if (tailBits !== 0) this.#words[this.#wordCount - 1] &= (1 << tailBits) - 1;
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (
      this.#disposed || Atomics.load(this.#header, WRITER_OWNER_INDEX) !== this.#owner
    ) {
      throw new Error("SharedSelectionMask writer has been disposed or lost ownership");
    }
  }
}

class SharedSelectionMaskGenerationView implements SharedSelectionMaskView {
  readonly capacity: number;
  readonly generation: number;
  readonly dataByteOffset: number;
  readonly paddedWords: number;
  readonly #buffer: SharedSelectionMaskBuffer;
  readonly #header: Int32Array;
  readonly #words: Uint32Array;
  readonly #wordCount: number;

  constructor(
    buffer: SharedSelectionMaskBuffer,
    header: Int32Array,
    words: Uint32Array,
    capacity: number,
    wordCount: number,
    paddedWords: number,
    dataByteOffset: number,
    generation: number,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.#words = words;
    this.capacity = capacity;
    this.#wordCount = wordCount;
    this.paddedWords = paddedWords;
    this.dataByteOffset = dataByteOffset;
    this.generation = generation;
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

  #assertCurrent(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if ((Atomics.load(this.#header, GENERATION_INDEX) >>> 0) !== this.generation) {
      throw new Error("SharedSelectionMask generation is stale");
    }
  }
}

interface Layout {
  readonly capacity: number;
  readonly wordCount: number;
  readonly paddedWords: number;
  readonly dataOffset: number;
  readonly byteLength: number;
}

function layoutFor(capacity: number): Layout {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0xffff_ffff) {
    throw new RangeError("capacity must be an unsigned 32-bit integer");
  }
  const wordCount = Math.ceil(capacity / 32);
  const paddedWords = alignTo(wordCount, 4);
  const dataOffset = CACHE_LINE_BYTES;
  const byteLength = alignTo(dataOffset + paddedWords * 4, CACHE_LINE_BYTES);
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("SharedSelectionMask layout exceeds the safe integer range");
  }
  return { capacity, wordCount, paddedWords, dataOffset, byteLength };
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${CACHE_LINE_BYTES}-byte aligned`);
  }
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
    throw new RangeError("generation must be a positive signed 32-bit integer");
  }
}

function nextGeneration(generation: number): number {
  return generation >= MAX_GENERATION ? 1 : generation + 1;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
