const HEADER_BYTES = 64;
const HEADER_WORDS = HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT;
const MAGIC = 0x5549_4442;
const ABI_VERSION = 1;
const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const WORD_COUNT_INDEX = 3;

/**
 * An attachable multi-producer dirty-effect set.
 *
 * `mark` and each word of `drain` are linearizable. A mark concurrent with drain is therefore
 * observed either by the current drain or the next one, never lost. Cross-word snapshots are not
 * transactional, which is deliberate for UI scheduling: work may move to the next microtask.
 */
export class AtomicEffectBatch {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly wordCount: number;
  readonly #words: Int32Array;

  private constructor(buffer: SharedArrayBuffer, capacity: number, wordCount: number) {
    this.buffer = buffer;
    this.capacity = capacity;
    this.wordCount = wordCount;
    this.#words = new Int32Array(buffer, HEADER_BYTES, wordCount);
  }

  static create(capacity: number): AtomicEffectBatch {
    const wordCount = validateCapacity(capacity);
    const byteLength = HEADER_BYTES + wordCount * Int32Array.BYTES_PER_ELEMENT;
    const buffer = new SharedArrayBuffer(byteLength);
    const header = new Int32Array(buffer, 0, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, WORD_COUNT_INDEX, wordCount);
    Atomics.store(header, MAGIC_INDEX, MAGIC);
    return new AtomicEffectBatch(buffer, capacity, wordCount);
  }

  static attach(buffer: SharedArrayBuffer): AtomicEffectBatch {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
      throw new RangeError("buffer is too small for AtomicEffectBatch");
    }
    const header = new Int32Array(buffer, 0, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== MAGIC) {
      throw new RangeError("buffer does not contain an AtomicEffectBatch");
    }
    if (Atomics.load(header, VERSION_INDEX) !== ABI_VERSION) {
      throw new RangeError("unsupported AtomicEffectBatch ABI version");
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    const wordCount = validateCapacity(capacity);
    if (
      (Atomics.load(header, WORD_COUNT_INDEX) >>> 0) !== wordCount ||
      buffer.byteLength !== HEADER_BYTES + wordCount * Int32Array.BYTES_PER_ELEMENT
    ) {
      throw new RangeError("invalid AtomicEffectBatch layout");
    }
    return new AtomicEffectBatch(buffer, capacity, wordCount);
  }

  /** Sets an effect bit and returns true only for the producer that changed it from clear to set. */
  mark(effectId: number): boolean {
    const { wordIndex, mask } = this.#locate(effectId);
    return (Atomics.or(this.#words, wordIndex, mask) & mask) === 0;
  }

  /** Returns the number of newly-set effect bits observed by this producer. */
  markMany(effectIds: Iterable<number>): number {
    if (effectIds === null || effectIds === undefined || effectIds[Symbol.iterator] === undefined) {
      throw new TypeError("effectIds must be iterable");
    }
    let marked = 0;
    for (const effectId of effectIds) if (this.mark(effectId)) marked++;
    return marked;
  }

  /** Atomically claims all currently observed words and returns sorted effect IDs. */
  drain(): Uint32Array {
    const result: number[] = [];
    for (let wordIndex = 0; wordIndex < this.wordCount; wordIndex++) {
      let word = Atomics.exchange(this.#words, wordIndex, 0) >>> 0;
      while (word !== 0) {
        const lowest = word & -word;
        const effectId = (wordIndex << 5) + 31 - Math.clz32(lowest);
        if (effectId < this.capacity) result.push(effectId);
        word = (word & (word - 1)) >>> 0;
      }
    }
    return Uint32Array.from(result);
  }

  #locate(effectId: number): { readonly wordIndex: number; readonly mask: number } {
    if (!Number.isSafeInteger(effectId) || effectId < 0 || effectId >= this.capacity) {
      throw new RangeError("effect ID out of bounds");
    }
    return { wordIndex: effectId >>> 5, mask: 1 << (effectId & 31) };
  }
}

function validateCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 0xffff_ffff) {
    throw new RangeError("capacity must be an unsigned 32-bit integer");
  }
  const wordCount = Math.ceil(capacity / 32);
  if (HEADER_BYTES + wordCount * 4 > 0x7fff_ffff) {
    throw new RangeError("capacity exceeds SharedArrayBuffer layout limit");
  }
  return wordCount;
}
