const HEADER_WORDS = 16;
const MAGIC = 0x5549_4e50;
const ABI_VERSION = 1;
const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const RECORD_WORDS_INDEX = 3;
const LATEST_VERSION_INDEX = 4;
const WRITE_CURSOR_INDEX = 5;
const READ_CURSOR_INDEX = 6;
const DROPPED_INDEX = 7;
const WAKE_SEQUENCE_INDEX = 8;
const LATEST_OFFSET = HEADER_WORDS;
const RING_OFFSET = LATEST_OFFSET + 8;

export const ATOMIC_INPUT_RECORD_WORDS = 8;
export const ATOMIC_INPUT_KIND = {
  pointerDown: 1,
  pointerMove: 2,
  pointerUp: 3,
  pointerCancel: 4,
  click: 5,
} as const;

export type AtomicInputKind = typeof ATOMIC_INPUT_KIND[keyof typeof ATOMIC_INPUT_KIND];

export interface AtomicInputRecord {
  readonly kind: number;
  readonly targetId: number;
  readonly xFixed: number;
  readonly yFixed: number;
  readonly pointerId: number;
  readonly buttons: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly timeMicros: number;
  readonly pressure: number;
  readonly detail: number;
}

/** Single-producer/single-consumer input bridge with a coalesced latest slot and discrete ring. */
export class AtomicInputBuffer {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly #words: Int32Array;
  readonly #mask: number;

  private constructor(buffer: SharedArrayBuffer, capacity: number) {
    this.buffer = buffer;
    this.capacity = capacity;
    this.#mask = capacity - 1;
    this.#words = new Int32Array(buffer);
  }

  static create(capacity: number): AtomicInputBuffer {
    validateCapacity(capacity);
    const buffer = new SharedArrayBuffer(
      (RING_OFFSET + capacity * ATOMIC_INPUT_RECORD_WORDS) * Int32Array.BYTES_PER_ELEMENT,
    );
    const words = new Int32Array(buffer);
    Atomics.store(words, VERSION_INDEX, ABI_VERSION);
    Atomics.store(words, CAPACITY_INDEX, capacity);
    Atomics.store(words, RECORD_WORDS_INDEX, ATOMIC_INPUT_RECORD_WORDS);
    Atomics.store(words, MAGIC_INDEX, MAGIC);
    return new AtomicInputBuffer(buffer, capacity);
  }

  static attach(buffer: SharedArrayBuffer): AtomicInputBuffer {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < RING_OFFSET * 4) {
      throw new RangeError("buffer is too small for AtomicInputBuffer");
    }
    const words = new Int32Array(buffer);
    if (Atomics.load(words, MAGIC_INDEX) !== MAGIC) {
      throw new RangeError("buffer does not contain an AtomicInputBuffer");
    }
    if (Atomics.load(words, VERSION_INDEX) !== ABI_VERSION) {
      throw new RangeError("unsupported AtomicInputBuffer ABI version");
    }
    const capacity = Atomics.load(words, CAPACITY_INDEX) >>> 0;
    validateCapacity(capacity);
    if (
      Atomics.load(words, RECORD_WORDS_INDEX) !== ATOMIC_INPUT_RECORD_WORDS ||
      buffer.byteLength !== (RING_OFFSET + capacity * ATOMIC_INPUT_RECORD_WORDS) * 4
    ) {
      throw new RangeError("invalid AtomicInputBuffer layout");
    }
    return new AtomicInputBuffer(buffer, capacity);
  }

  /** Overwrites the latest coalesced pointer state and returns its even publication sequence. */
  publishLatest(
    kind: AtomicInputKind,
    targetId: number,
    xFixed: number,
    yFixed: number,
    pointerId: number,
    flags: number,
    timeMicros: number,
    detail: number,
  ): number {
    const writing = (Atomics.add(this.#words, LATEST_VERSION_INDEX, 1) + 1) | 0;
    this.#storeRecord(
      LATEST_OFFSET,
      kind,
      targetId,
      xFixed,
      yFixed,
      pointerId,
      flags,
      timeMicros,
      detail,
    );
    const published = (writing + 1) | 0;
    Atomics.store(this.#words, LATEST_VERSION_INDEX, published);
    this.#wakeConsumer();
    return published >>> 0;
  }

  /** Copies a consistent latest record into caller-owned storage; zero means no stable record. */
  readLatestInto(destination: Int32Array, offset = 0): number {
    validateDestination(destination, offset, 1);
    for (let attempt = 0; attempt < 16; attempt++) {
      const before = Atomics.load(this.#words, LATEST_VERSION_INDEX);
      if (before === 0) return 0;
      if ((before & 1) !== 0) continue;
      for (let word = 0; word < ATOMIC_INPUT_RECORD_WORDS; word++) {
        destination[offset + word] = Atomics.load(this.#words, LATEST_OFFSET + word);
      }
      if (Atomics.load(this.#words, LATEST_VERSION_INDEX) === before) return before >>> 0;
    }
    return 0;
  }

  /** Enqueues one lossless discrete input record, or drops it when the ring is full. */
  push(
    kind: AtomicInputKind,
    targetId: number,
    xFixed: number,
    yFixed: number,
    pointerId: number,
    flags: number,
    timeMicros: number,
    detail: number,
  ): boolean {
    const write = Atomics.load(this.#words, WRITE_CURSOR_INDEX) >>> 0;
    const read = Atomics.load(this.#words, READ_CURSOR_INDEX) >>> 0;
    if (((write - read) >>> 0) >= this.capacity) {
      Atomics.add(this.#words, DROPPED_INDEX, 1);
      return false;
    }
    const recordOffset = RING_OFFSET + (write & this.#mask) * ATOMIC_INPUT_RECORD_WORDS;
    this.#storeRecord(
      recordOffset,
      kind,
      targetId,
      xFixed,
      yFixed,
      pointerId,
      flags,
      timeMicros,
      detail,
    );
    Atomics.store(this.#words, WRITE_CURSOR_INDEX, (write + 1) | 0);
    this.#wakeConsumer();
    return true;
  }

  /** Drains packed records into caller-owned storage and returns the record count. */
  drainInto(destination: Int32Array, offset = 0): number {
    const recordCapacity = validateDestination(
      destination,
      offset,
      Math.floor((destination.length - offset) / ATOMIC_INPUT_RECORD_WORDS),
    );
    const read = Atomics.load(this.#words, READ_CURSOR_INDEX) >>> 0;
    const write = Atomics.load(this.#words, WRITE_CURSOR_INDEX) >>> 0;
    const count = Math.min((write - read) >>> 0, recordCapacity);
    for (let record = 0; record < count; record++) {
      const source = RING_OFFSET + ((read + record) & this.#mask) * ATOMIC_INPUT_RECORD_WORDS;
      const target = offset + record * ATOMIC_INPUT_RECORD_WORDS;
      for (let word = 0; word < ATOMIC_INPUT_RECORD_WORDS; word++) {
        destination[target + word] = Atomics.load(this.#words, source + word);
      }
    }
    if (count > 0) Atomics.store(this.#words, READ_CURSOR_INDEX, (read + count) | 0);
    return count;
  }

  get droppedCount(): number {
    return Atomics.load(this.#words, DROPPED_INDEX) >>> 0;
  }

  get wakeSequence(): number {
    return Atomics.load(this.#words, WAKE_SEQUENCE_INDEX) >>> 0;
  }

  /** Worker-only blocking wait. Drain both latest and discrete records after it returns. */
  waitForInput(sequence: number, timeout?: number): "ok" | "not-equal" | "timed-out" {
    return Atomics.wait(this.#words, WAKE_SEQUENCE_INDEX, sequence | 0, timeout);
  }

  #wakeConsumer(): void {
    Atomics.add(this.#words, WAKE_SEQUENCE_INDEX, 1);
    Atomics.notify(this.#words, WAKE_SEQUENCE_INDEX);
  }

  #storeRecord(
    offset: number,
    kind: AtomicInputKind,
    targetId: number,
    xFixed: number,
    yFixed: number,
    pointerId: number,
    flags: number,
    timeMicros: number,
    detail: number,
  ): void {
    Atomics.store(this.#words, offset, kind);
    Atomics.store(this.#words, offset + 1, targetId | 0);
    Atomics.store(this.#words, offset + 2, xFixed | 0);
    Atomics.store(this.#words, offset + 3, yFixed | 0);
    Atomics.store(this.#words, offset + 4, pointerId | 0);
    Atomics.store(this.#words, offset + 5, flags | 0);
    Atomics.store(this.#words, offset + 6, timeMicros | 0);
    Atomics.store(this.#words, offset + 7, detail | 0);
  }
}

export function decodeAtomicInputRecord(
  records: Int32Array,
  recordIndex = 0,
): AtomicInputRecord {
  const offset = recordIndex * ATOMIC_INPUT_RECORD_WORDS;
  if (offset < 0 || offset + ATOMIC_INPUT_RECORD_WORDS > records.length) {
    throw new RangeError("record index out of bounds");
  }
  const flags = records[offset + 5]! >>> 0;
  const detail = records[offset + 7]! >>> 0;
  const modifiers = flags >>> 24;
  return {
    kind: records[offset]!,
    targetId: records[offset + 1]! >>> 0,
    xFixed: records[offset + 2]!,
    yFixed: records[offset + 3]!,
    pointerId: records[offset + 4]!,
    buttons: flags & 0xffff,
    button: ((flags >>> 16) & 0xff) - 1,
    shiftKey: (modifiers & 1) !== 0,
    ctrlKey: (modifiers & 2) !== 0,
    altKey: (modifiers & 4) !== 0,
    metaKey: (modifiers & 8) !== 0,
    timeMicros: records[offset + 6]! >>> 0,
    pressure: (detail & 0xffff) / 0xffff,
    detail: detail >>> 16,
  };
}

function validateCapacity(capacity: number): void {
  if (
    !Number.isSafeInteger(capacity) || capacity < 2 || capacity > 1_048_576 ||
    (capacity & (capacity - 1)) !== 0
  ) {
    throw new RangeError("capacity must be a power of two between 2 and 1048576");
  }
}

function validateDestination(destination: Int32Array, offset: number, records: number): number {
  if (!(destination instanceof Int32Array)) throw new TypeError("destination must be Int32Array");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > destination.length) {
    throw new RangeError("destination offset out of bounds");
  }
  const available = Math.floor((destination.length - offset) / ATOMIC_INPUT_RECORD_WORDS);
  if (records <= 0 || available <= 0) throw new RangeError("destination has no complete record");
  return available;
}
