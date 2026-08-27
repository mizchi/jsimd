export const ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES = 64;

const BITMAP_MAGIC = 0x4154_424d;
const BITMAP_ABI_VERSION = 1;
const HEADER_WORDS = ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const DATA_BYTE_OFFSET = ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const WORD_COUNT_INDEX = 3;
const DATA_OFFSET_INDEX = 4;
const BYTE_LENGTH_INDEX = 5;

/** Shared-memory views required by AtomicDenseBitmap. */
export interface AtomicDenseBitmapBuffer {
  readonly disposed: boolean;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
}

/**
 * A fixed-universe bitmap with linearizable scalar point operations.
 *
 * The view does not own its backing memory. Keep the surrounding SharedBuffer lease alive while
 * using it. Consistent bulk reads belong to a later shard or snapshot layer.
 */
export class AtomicDenseBitmap {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly wordCount: number;
  readonly #buffer: AtomicDenseBitmapBuffer;
  readonly #words: Int32Array;

  private constructor(
    buffer: AtomicDenseBitmapBuffer,
    byteOffset: number,
    capacity: number,
    wordCount: number,
    byteLength: number,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + DATA_BYTE_OFFSET;
    this.capacity = capacity;
    this.wordCount = wordCount;
    this.#words = buffer.int32Array(this.dataByteOffset, wordCount);
  }

  static byteLengthFor(capacity: number): number {
    const wordCount = validateCapacity(capacity);
    return alignTo(
      DATA_BYTE_OFFSET + wordCount * Uint32Array.BYTES_PER_ELEMENT,
      ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES,
    );
  }

  /** Initializes the bitmap before its SharedBuffer is published to Workers. */
  static initialize(
    buffer: AtomicDenseBitmapBuffer,
    byteOffset: number,
    capacity: number,
  ): AtomicDenseBitmap {
    validateByteOffset(byteOffset);
    const wordCount = validateCapacity(capacity);
    const byteLength = AtomicDenseBitmap.byteLengthFor(capacity);
    buffer.uint32Array(byteOffset, byteLength / Uint32Array.BYTES_PER_ELEMENT).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, BITMAP_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, WORD_COUNT_INDEX, wordCount);
    Atomics.store(header, DATA_OFFSET_INDEX, DATA_BYTE_OFFSET);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, MAGIC_INDEX, BITMAP_MAGIC);
    return new AtomicDenseBitmap(buffer, byteOffset, capacity, wordCount, byteLength);
  }

  static attach(buffer: AtomicDenseBitmapBuffer, byteOffset: number): AtomicDenseBitmap {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== BITMAP_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized AtomicDenseBitmap");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== BITMAP_ABI_VERSION) {
      throw new RangeError(`unsupported AtomicDenseBitmap ABI version: ${version}`);
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    const wordCount = validateCapacity(capacity);
    const byteLength = AtomicDenseBitmap.byteLengthFor(capacity);
    if (
      (Atomics.load(header, WORD_COUNT_INDEX) >>> 0) !== wordCount ||
      Atomics.load(header, DATA_OFFSET_INDEX) !== DATA_BYTE_OFFSET ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== byteLength
    ) {
      throw new RangeError("invalid AtomicDenseBitmap layout");
    }
    buffer.uint32Array(byteOffset, byteLength / Uint32Array.BYTES_PER_ELEMENT);
    return new AtomicDenseBitmap(buffer, byteOffset, capacity, wordCount, byteLength);
  }

  has(bit: number): boolean {
    const { wordIndex, mask } = this.#locate(bit);
    return (Atomics.load(this.#words, wordIndex) & mask) !== 0;
  }

  set(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    Atomics.or(this.#words, wordIndex, mask);
  }

  clear(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    Atomics.and(this.#words, wordIndex, ~mask);
  }

  toggle(bit: number): void {
    const { wordIndex, mask } = this.#locate(bit);
    Atomics.xor(this.#words, wordIndex, mask);
  }

  /** Atomically sets a bit and returns whether it was already set. */
  testAndSet(bit: number): boolean {
    const { wordIndex, mask } = this.#locate(bit);
    return (Atomics.or(this.#words, wordIndex, mask) & mask) !== 0;
  }

  /** Atomically clears a bit and returns whether it was set. */
  testAndClear(bit: number): boolean {
    const { wordIndex, mask } = this.#locate(bit);
    return (Atomics.and(this.#words, wordIndex, ~mask) & mask) !== 0;
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
  }
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(
      `byteOffset must be ${ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES}-byte aligned`,
    );
  }
}

function validateCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0xffff_ffff) {
    throw new RangeError("capacity must be an unsigned 32-bit integer");
  }
  return Math.ceil(capacity / 32);
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
