import type { SharedRingBufferSource } from "./spsc-ring.ts";
import { releaseSharedOwner, tryClaimSharedOwner } from "./ownership.ts";

export const WORK_STEALING_DEQUE_CACHE_LINE_BYTES = 64;

const DEQUE_MAGIC = 0x5753_4451;
const DEQUE_ABI_VERSION = 1;
const HEADER_WORDS = WORK_STEALING_DEQUE_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const TOP_BYTE_OFFSET = WORK_STEALING_DEQUE_CACHE_LINE_BYTES;
const BOTTOM_BYTE_OFFSET = WORK_STEALING_DEQUE_CACHE_LINE_BYTES * 2;
const DATA_BYTE_OFFSET = WORK_STEALING_DEQUE_CACHE_LINE_BYTES * 3;
const MAX_CAPACITY = 0x4000_0000;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const BYTE_LENGTH_INDEX = 3;
const DATA_OFFSET_INDEX = 4;
const OWNER_INDEX = 5;
const COUNTER_INDEX = 0;

export interface WorkStealingDequeOwnerU32 extends Disposable {
  readonly disposed: boolean;
  tryPush(task: number): boolean;
  pushMany(tasks: Uint32Array): number;
  tryPop(): number | undefined;
  popMany(output: Uint32Array): number;
}

/** Fixed-capacity Chase-Lev deque with one owner and any number of u32 thieves. */
export class WorkStealingDequeU32 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly #buffer: SharedRingBufferSource;
  readonly #header: Int32Array;
  readonly #top: Int32Array;
  readonly #bottom: Int32Array;
  readonly #data: Int32Array;
  readonly #mask: number;

  private constructor(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
    byteLength: number,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + DATA_BYTE_OFFSET;
    this.capacity = capacity;
    this.#mask = capacity - 1;
    this.#top = buffer.int32Array(byteOffset + TOP_BYTE_OFFSET, HEADER_WORDS);
    this.#bottom = buffer.int32Array(byteOffset + BOTTOM_BYTE_OFFSET, HEADER_WORDS);
    this.#data = buffer.int32Array(this.dataByteOffset, capacity);
  }

  static byteLengthFor(capacity: number): number {
    validateCapacity(capacity);
    return alignTo(
      DATA_BYTE_OFFSET + capacity * Uint32Array.BYTES_PER_ELEMENT,
      WORK_STEALING_DEQUE_CACHE_LINE_BYTES,
    );
  }

  static initialize(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
  ): WorkStealingDequeU32 {
    validateByteOffset(byteOffset);
    validateCapacity(capacity);
    const byteLength = WorkStealingDequeU32.byteLengthFor(capacity);
    buffer.uint32Array(byteOffset, byteLength / 4).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, DEQUE_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, DATA_OFFSET_INDEX, DATA_BYTE_OFFSET);
    Atomics.store(header, MAGIC_INDEX, DEQUE_MAGIC);
    return new WorkStealingDequeU32(buffer, byteOffset, capacity, byteLength, header);
  }

  static attach(buffer: SharedRingBufferSource, byteOffset: number): WorkStealingDequeU32 {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== DEQUE_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized WorkStealingDequeU32");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== DEQUE_ABI_VERSION) {
      throw new RangeError(`unsupported WorkStealingDequeU32 ABI version: ${version}`);
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    validateCapacity(capacity);
    const byteLength = WorkStealingDequeU32.byteLengthFor(capacity);
    if (
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== byteLength ||
      Atomics.load(header, DATA_OFFSET_INDEX) !== DATA_BYTE_OFFSET
    ) {
      throw new RangeError("invalid WorkStealingDequeU32 layout");
    }
    buffer.uint32Array(byteOffset, byteLength / 4);
    return new WorkStealingDequeU32(buffer, byteOffset, capacity, byteLength, header);
  }

  owner(): WorkStealingDequeOwnerU32 {
    this.#assertAlive();
    if (!tryClaimSharedOwner(this.#buffer, this.#header, OWNER_INDEX)) {
      throw new RangeError("WorkStealingDequeU32 owner role is already claimed");
    }
    return new OwnerLease(
      this.#buffer,
      this.#header,
      this.#top,
      this.#bottom,
      this.#data,
      this.capacity,
      this.#mask,
      this.#buffer.leaseToken,
    );
  }

  trySteal(): number | undefined {
    this.#assertAlive();
    while (true) {
      const top = Atomics.load(this.#top, COUNTER_INDEX) >>> 0;
      const bottom = Atomics.load(this.#bottom, COUNTER_INDEX) >>> 0;
      const size = (bottom - top) >>> 0;
      if (size === 0 || size > 0x7fff_ffff) return undefined;
      const task = Atomics.load(this.#data, top & this.#mask) >>> 0;
      if (
        (Atomics.compareExchange(this.#top, COUNTER_INDEX, top, (top + 1) >>> 0) >>> 0) === top
      ) {
        return task;
      }
    }
  }

  stealMany(output: Uint32Array): number {
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    let count = 0;
    while (count < output.length) {
      const task = this.trySteal();
      if (task === undefined) break;
      output[count++] = task;
    }
    return count;
  }

  get sizeApprox(): number {
    this.#assertAlive();
    const top = Atomics.load(this.#top, COUNTER_INDEX) >>> 0;
    const bottom = Atomics.load(this.#bottom, COUNTER_INDEX) >>> 0;
    const size = (bottom - top) >>> 0;
    return size <= this.capacity ? size : 0;
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class OwnerLease implements WorkStealingDequeOwnerU32 {
  readonly #buffer: SharedRingBufferSource;
  readonly #header: Int32Array;
  readonly #top: Int32Array;
  readonly #bottom: Int32Array;
  readonly #data: Int32Array;
  readonly #capacity: number;
  readonly #mask: number;
  readonly #owner: number;
  #disposed = false;

  constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    top: Int32Array,
    bottom: Int32Array,
    data: Int32Array,
    capacity: number,
    mask: number,
    owner: number,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.#top = top;
    this.#bottom = bottom;
    this.#data = data;
    this.#capacity = capacity;
    this.#mask = mask;
    this.#owner = owner;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  tryPush(task: number): boolean {
    this.#assertAlive();
    validateUint32(task, "task");
    const bottom = Atomics.load(this.#bottom, COUNTER_INDEX) >>> 0;
    const top = Atomics.load(this.#top, COUNTER_INDEX) >>> 0;
    if (((bottom - top) >>> 0) >= this.#capacity) return false;
    Atomics.store(this.#data, bottom & this.#mask, task);
    Atomics.store(this.#bottom, COUNTER_INDEX, (bottom + 1) >>> 0);
    Atomics.notify(this.#bottom, COUNTER_INDEX);
    return true;
  }

  pushMany(tasks: Uint32Array): number {
    this.#assertAlive();
    if (!(tasks instanceof Uint32Array)) throw new TypeError("tasks must be a Uint32Array");
    let count = 0;
    while (count < tasks.length && this.tryPush(tasks[count]!)) count++;
    return count;
  }

  tryPop(): number | undefined {
    this.#assertAlive();
    const bottom = (Atomics.load(this.#bottom, COUNTER_INDEX) - 1) >>> 0;
    Atomics.store(this.#bottom, COUNTER_INDEX, bottom);
    const top = Atomics.load(this.#top, COUNTER_INDEX) >>> 0;
    const size = (bottom - top) >>> 0;
    if (size > 0x7fff_ffff) {
      Atomics.store(this.#bottom, COUNTER_INDEX, top);
      return undefined;
    }
    const task = Atomics.load(this.#data, bottom & this.#mask) >>> 0;
    if (size === 0) {
      const claimed = (Atomics.compareExchange(
        this.#top,
        COUNTER_INDEX,
        top,
        (top + 1) >>> 0,
      ) >>> 0) === top;
      Atomics.store(this.#bottom, COUNTER_INDEX, (top + 1) >>> 0);
      return claimed ? task : undefined;
    }
    return task;
  }

  popMany(output: Uint32Array): number {
    this.#assertAlive();
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    let count = 0;
    while (count < output.length) {
      const task = this.tryPop();
      if (task === undefined) break;
      output[count++] = task;
    }
    return count;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseSharedOwner(this.#buffer, this.#header, OWNER_INDEX);
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (this.#disposed || Atomics.load(this.#header, OWNER_INDEX) !== this.#owner) {
      throw new Error("WorkStealingDequeU32 owner has been disposed or lost ownership");
    }
  }
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % WORK_STEALING_DEQUE_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(
      `byteOffset must be ${WORK_STEALING_DEQUE_CACHE_LINE_BYTES}-byte aligned`,
    );
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

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
