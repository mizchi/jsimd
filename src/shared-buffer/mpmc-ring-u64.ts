import { waitForAtomicChangeAsync, waitForAtomicChangeBlocking } from "./sync.ts";
import type { SharedRingBufferSource } from "./spsc-ring.ts";

const RING_MAGIC = 0x4d36_3451;
const RING_ABI_VERSION = 1;
const CACHE_LINE_BYTES = 64;
const HEADER_WORDS = CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const ENQUEUE_BYTE_OFFSET = CACHE_LINE_BYTES;
const DEQUEUE_BYTE_OFFSET = CACHE_LINE_BYTES * 2;
const SLOTS_BYTE_OFFSET = CACHE_LINE_BYTES * 3;
const SLOT_WORDS = 4;
const SLOT_BYTES = SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT;
const MAX_CAPACITY = 0x4000_0000;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const BYTE_LENGTH_INDEX = 3;
const SLOTS_OFFSET_INDEX = 4;
const POSITION_INDEX = 0;
const PAYLOAD_LOW_WORD = 2;
const PAYLOAD_HIGH_WORD = 3;

/** A bounded MPMC queue whose per-slot sequence atomically publishes one complete u64 item. */
export class MpmcRingBufferU64 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly #buffer: SharedRingBufferSource;
  readonly #enqueue: Int32Array;
  readonly #dequeue: Int32Array;
  readonly #slots: Int32Array;
  readonly #payloads: Uint32Array;
  readonly #mask: number;

  private constructor(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
    byteLength: number,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + SLOTS_BYTE_OFFSET;
    this.capacity = capacity;
    this.#mask = capacity - 1;
    this.#enqueue = buffer.int32Array(byteOffset + ENQUEUE_BYTE_OFFSET, HEADER_WORDS);
    this.#dequeue = buffer.int32Array(byteOffset + DEQUEUE_BYTE_OFFSET, HEADER_WORDS);
    this.#slots = buffer.int32Array(this.dataByteOffset, capacity * SLOT_WORDS);
    this.#payloads = buffer.uint32Array(this.dataByteOffset, capacity * SLOT_WORDS);
  }

  static byteLengthFor(capacity: number): number {
    validateCapacity(capacity);
    return alignTo(SLOTS_BYTE_OFFSET + capacity * SLOT_BYTES, CACHE_LINE_BYTES);
  }

  static initialize(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
  ): MpmcRingBufferU64 {
    validateByteOffset(byteOffset);
    const byteLength = MpmcRingBufferU64.byteLengthFor(capacity);
    buffer.uint32Array(byteOffset, byteLength / 4).fill(0);
    const slots = buffer.int32Array(byteOffset + SLOTS_BYTE_OFFSET, capacity * SLOT_WORDS);
    for (let index = 0; index < capacity; index++) {
      Atomics.store(slots, index * SLOT_WORDS, index);
    }
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, RING_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, SLOTS_OFFSET_INDEX, SLOTS_BYTE_OFFSET);
    Atomics.store(header, MAGIC_INDEX, RING_MAGIC);
    return new MpmcRingBufferU64(buffer, byteOffset, capacity, byteLength);
  }

  static attach(buffer: SharedRingBufferSource, byteOffset: number): MpmcRingBufferU64 {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== RING_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized MpmcRingBufferU64");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== RING_ABI_VERSION) {
      throw new RangeError(`unsupported MpmcRingBufferU64 ABI version: ${version}`);
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    validateCapacity(capacity);
    const byteLength = Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0;
    if (
      byteLength !== MpmcRingBufferU64.byteLengthFor(capacity) ||
      Atomics.load(header, SLOTS_OFFSET_INDEX) !== SLOTS_BYTE_OFFSET
    ) {
      throw new RangeError("invalid MpmcRingBufferU64 layout");
    }
    buffer.uint32Array(byteOffset, byteLength / 4);
    return new MpmcRingBufferU64(buffer, byteOffset, capacity, byteLength);
  }

  tryPush(value: bigint): boolean {
    this.#assertAlive();
    validateUint64(value);
    while (true) {
      const position = Atomics.load(this.#enqueue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex) >>> 0;
      const difference = (sequence - position) | 0;
      if (difference < 0) return false;
      if (difference > 0) continue;
      if (
        (Atomics.compareExchange(
          this.#enqueue,
          POSITION_INDEX,
          position,
          (position + 1) >>> 0,
        ) >>> 0) !== position
      ) continue;
      writeUint64(this.#payloads, sequenceIndex, value);
      Atomics.store(this.#slots, sequenceIndex, (position + 1) >>> 0);
      Atomics.notify(this.#slots, sequenceIndex);
      return true;
    }
  }

  push(value: bigint): void {
    validateUint64(value);
    while (!this.tryPush(value)) {
      const position = Atomics.load(this.#enqueue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex);
      if ((((sequence >>> 0) - position) | 0) >= 0) continue;
      waitForAtomicChangeBlocking(this.#slots, sequenceIndex, sequence, "MpmcRingBufferU64.push");
    }
  }

  async pushAsync(value: bigint): Promise<void> {
    validateUint64(value);
    while (!this.tryPush(value)) {
      const position = Atomics.load(this.#enqueue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex);
      if ((((sequence >>> 0) - position) | 0) >= 0) continue;
      await waitForAtomicChangeAsync(this.#slots, sequenceIndex, sequence);
    }
  }

  pushMany(values: BigUint64Array): number {
    this.#assertAlive();
    if (!(values instanceof BigUint64Array)) throw new TypeError("values must be a BigUint64Array");
    let count = 0;
    while (count < values.length && this.tryPush(values[count]!)) count++;
    return count;
  }

  tryPop(): bigint | undefined {
    this.#assertAlive();
    while (true) {
      const position = Atomics.load(this.#dequeue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex) >>> 0;
      const expected = (position + 1) >>> 0;
      const difference = (sequence - expected) | 0;
      if (difference < 0) return undefined;
      if (difference > 0) continue;
      if (
        (Atomics.compareExchange(
          this.#dequeue,
          POSITION_INDEX,
          position,
          (position + 1) >>> 0,
        ) >>> 0) !== position
      ) continue;
      const value = readUint64(this.#payloads, sequenceIndex);
      Atomics.store(this.#slots, sequenceIndex, (position + this.capacity) >>> 0);
      Atomics.notify(this.#slots, sequenceIndex);
      return value;
    }
  }

  pop(): bigint {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const position = Atomics.load(this.#dequeue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex);
      if ((((sequence >>> 0) - ((position + 1) >>> 0)) | 0) >= 0) continue;
      waitForAtomicChangeBlocking(this.#slots, sequenceIndex, sequence, "MpmcRingBufferU64.pop");
    }
  }

  async popAsync(): Promise<bigint> {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const position = Atomics.load(this.#dequeue, POSITION_INDEX) >>> 0;
      const sequenceIndex = (position & this.#mask) * SLOT_WORDS;
      const sequence = Atomics.load(this.#slots, sequenceIndex);
      if ((((sequence >>> 0) - ((position + 1) >>> 0)) | 0) >= 0) continue;
      await waitForAtomicChangeAsync(this.#slots, sequenceIndex, sequence);
    }
  }

  popMany(output: BigUint64Array): number {
    this.#assertAlive();
    if (!(output instanceof BigUint64Array)) throw new TypeError("output must be a BigUint64Array");
    let count = 0;
    while (count < output.length) {
      const value = this.tryPop();
      if (value === undefined) break;
      output[count++] = value;
    }
    return count;
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

function writeUint64(payloads: Uint32Array, sequenceIndex: number, value: bigint): void {
  payloads[sequenceIndex + PAYLOAD_LOW_WORD] = Number(value & 0xffff_ffffn);
  payloads[sequenceIndex + PAYLOAD_HIGH_WORD] = Number(value >> 32n);
}

function readUint64(payloads: Uint32Array, sequenceIndex: number): bigint {
  return BigInt(payloads[sequenceIndex + PAYLOAD_HIGH_WORD]!) << 32n |
    BigInt(payloads[sequenceIndex + PAYLOAD_LOW_WORD]!);
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${CACHE_LINE_BYTES}-byte aligned`);
  }
}

function validateCapacity(capacity: number): void {
  if (
    !Number.isSafeInteger(capacity) || capacity < 2 || capacity > MAX_CAPACITY ||
    (capacity & (capacity - 1)) !== 0
  ) {
    throw new RangeError(`capacity must be a power of two between 2 and ${MAX_CAPACITY}`);
  }
}

function validateUint64(value: bigint): void {
  if (typeof value !== "bigint") throw new TypeError("value must be a bigint");
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError("value must be an unsigned 64-bit integer");
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
