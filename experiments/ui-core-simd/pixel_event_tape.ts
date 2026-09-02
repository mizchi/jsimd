const MAGIC = 0x5058_4556;
const VERSION = 1;
const HEADER_WORDS = 8;
const HEADER = {
  magic: 0,
  version: 1,
  capacity: 2,
  recordWords: 3,
  write: 4,
  read: 5,
  dropped: 6,
  reserved: 7,
} as const;

export const PIXEL_EVENT_RECORD_WORDS = 4;
export const PIXEL_EVENT_KIND = {
  vaporized: 1,
  condensed: 2,
} as const;

export type PixelEventKind = typeof PIXEL_EVENT_KIND[keyof typeof PIXEL_EVENT_KIND];

export interface PixelEventSink {
  push(kind: PixelEventKind, index: number, before: number, after: number): boolean;
  recordDropped(count: number): void;
}

/** Fixed-width SPSC ring from a simulation Worker to UI/gameplay consumers. */
export class PixelEventTape {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly #words: Int32Array;
  readonly #mask: number;

  private constructor(buffer: SharedArrayBuffer, capacity: number) {
    this.buffer = buffer;
    this.capacity = capacity;
    this.#words = new Int32Array(buffer);
    this.#mask = capacity - 1;
  }

  static create(capacity: number): PixelEventTape {
    validateCapacity(capacity);
    const buffer = new SharedArrayBuffer(
      (HEADER_WORDS + capacity * PIXEL_EVENT_RECORD_WORDS) * Int32Array.BYTES_PER_ELEMENT,
    );
    const words = new Int32Array(buffer);
    Atomics.store(words, HEADER.version, VERSION);
    Atomics.store(words, HEADER.capacity, capacity);
    Atomics.store(words, HEADER.recordWords, PIXEL_EVENT_RECORD_WORDS);
    Atomics.store(words, HEADER.magic, MAGIC);
    return new PixelEventTape(buffer, capacity);
  }

  static attach(buffer: SharedArrayBuffer): PixelEventTape {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < HEADER_WORDS * 4) {
      throw new RangeError("buffer is too small for PixelEventTape");
    }
    const words = new Int32Array(buffer);
    if (
      Atomics.load(words, HEADER.magic) !== MAGIC ||
      Atomics.load(words, HEADER.version) !== VERSION
    ) {
      throw new RangeError("buffer does not contain a supported PixelEventTape");
    }
    const capacity = Atomics.load(words, HEADER.capacity) >>> 0;
    validateCapacity(capacity);
    if (
      Atomics.load(words, HEADER.recordWords) !== PIXEL_EVENT_RECORD_WORDS ||
      buffer.byteLength !== (HEADER_WORDS + capacity * PIXEL_EVENT_RECORD_WORDS) * 4
    ) throw new RangeError("invalid PixelEventTape layout");
    return new PixelEventTape(buffer, capacity);
  }

  push(kind: PixelEventKind, index: number, before: number, after: number): boolean {
    const write = Atomics.load(this.#words, HEADER.write) >>> 0;
    const read = Atomics.load(this.#words, HEADER.read) >>> 0;
    if (((write - read) >>> 0) >= this.capacity) {
      this.recordDropped(1);
      return false;
    }
    const offset = HEADER_WORDS + (write & this.#mask) * PIXEL_EVENT_RECORD_WORDS;
    Atomics.store(this.#words, offset, kind);
    Atomics.store(this.#words, offset + 1, index | 0);
    Atomics.store(this.#words, offset + 2, before | 0);
    Atomics.store(this.#words, offset + 3, after | 0);
    Atomics.store(this.#words, HEADER.write, (write + 1) | 0);
    return true;
  }

  drainInto(destination: Int32Array): number {
    if (!(destination instanceof Int32Array)) throw new TypeError("destination must be Int32Array");
    const recordCapacity = Math.floor(destination.length / PIXEL_EVENT_RECORD_WORDS);
    if (recordCapacity < 1) throw new RangeError("destination has no complete pixel event record");
    const read = Atomics.load(this.#words, HEADER.read) >>> 0;
    const write = Atomics.load(this.#words, HEADER.write) >>> 0;
    const count = Math.min((write - read) >>> 0, recordCapacity);
    for (let record = 0; record < count; record++) {
      const source = HEADER_WORDS + ((read + record) & this.#mask) * PIXEL_EVENT_RECORD_WORDS;
      const target = record * PIXEL_EVENT_RECORD_WORDS;
      for (let word = 0; word < PIXEL_EVENT_RECORD_WORDS; word++) {
        destination[target + word] = Atomics.load(this.#words, source + word);
      }
    }
    if (count > 0) Atomics.store(this.#words, HEADER.read, (read + count) | 0);
    return count;
  }

  get droppedCount(): number {
    return Atomics.load(this.#words, HEADER.dropped) >>> 0;
  }

  recordDropped(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("dropped event count must be a non-negative safe integer");
    }
    if (count > 0) Atomics.add(this.#words, HEADER.dropped, count | 0);
  }
}

function validateCapacity(capacity: number): void {
  if (
    !Number.isSafeInteger(capacity) || capacity < 2 || capacity > 1_048_576 ||
    (capacity & (capacity - 1)) !== 0
  ) throw new RangeError("capacity must be a power of two between 2 and 1048576");
}
