import { waitForAtomicChangeAsync, waitForAtomicChangeBlocking } from "./sync.ts";
import type { SharedRingBufferSource } from "./spsc-ring.ts";

const RING_MAGIC = 0x5336_3451;
const RING_ABI_VERSION = 1;
const CACHE_LINE_BYTES = 64;
const HEADER_WORDS = CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const HEAD_BYTE_OFFSET = CACHE_LINE_BYTES;
const TAIL_BYTE_OFFSET = CACHE_LINE_BYTES * 2;
const DATA_BYTE_OFFSET = CACHE_LINE_BYTES * 3;
const MAX_CAPACITY = 0x4000_0000;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const BYTE_LENGTH_INDEX = 3;
const DATA_OFFSET_INDEX = 4;
const PRODUCER_OWNER_INDEX = 5;
const CONSUMER_OWNER_INDEX = 6;
const COUNTER_INDEX = 0;

/** A fixed-capacity SPSC queue whose atomic publication covers one complete u64 item. */
export class SpscRingBufferU64 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly #buffer: SharedRingBufferSource;
  readonly #header: Int32Array;
  readonly #head: Int32Array;
  readonly #tail: Int32Array;
  readonly #data: Uint32Array;

  private constructor(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
    byteLength: number,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + DATA_BYTE_OFFSET;
    this.capacity = capacity;
    this.#header = header;
    this.#head = buffer.int32Array(byteOffset + HEAD_BYTE_OFFSET, HEADER_WORDS);
    this.#tail = buffer.int32Array(byteOffset + TAIL_BYTE_OFFSET, HEADER_WORDS);
    this.#data = buffer.uint32Array(this.dataByteOffset, capacity * 2);
  }

  static byteLengthFor(capacity: number): number {
    validateCapacity(capacity);
    return alignTo(
      DATA_BYTE_OFFSET + capacity * BigUint64Array.BYTES_PER_ELEMENT,
      CACHE_LINE_BYTES,
    );
  }

  static initialize(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
  ): SpscRingBufferU64 {
    validateByteOffset(byteOffset);
    const byteLength = SpscRingBufferU64.byteLengthFor(capacity);
    buffer.uint32Array(byteOffset, byteLength / 4).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, RING_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, DATA_OFFSET_INDEX, DATA_BYTE_OFFSET);
    Atomics.store(header, MAGIC_INDEX, RING_MAGIC);
    return new SpscRingBufferU64(buffer, byteOffset, capacity, byteLength, header);
  }

  static attach(buffer: SharedRingBufferSource, byteOffset: number): SpscRingBufferU64 {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== RING_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized SpscRingBufferU64");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== RING_ABI_VERSION) {
      throw new RangeError(`unsupported SpscRingBufferU64 ABI version: ${version}`);
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    validateCapacity(capacity);
    const byteLength = Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0;
    if (
      byteLength !== SpscRingBufferU64.byteLengthFor(capacity) ||
      Atomics.load(header, DATA_OFFSET_INDEX) !== DATA_BYTE_OFFSET
    ) {
      throw new RangeError("invalid SpscRingBufferU64 layout");
    }
    buffer.uint32Array(byteOffset, byteLength / 4);
    return new SpscRingBufferU64(buffer, byteOffset, capacity, byteLength, header);
  }

  producer(): SpscProducerU64 {
    this.#claimRole(PRODUCER_OWNER_INDEX, "producer");
    return new SpscProducerLeaseU64(
      this.#buffer,
      this.#header,
      this.#head,
      this.#tail,
      this.#data,
      this.capacity,
    );
  }

  consumer(): SpscConsumerU64 {
    this.#claimRole(CONSUMER_OWNER_INDEX, "consumer");
    return new SpscConsumerLeaseU64(
      this.#buffer,
      this.#header,
      this.#head,
      this.#tail,
      this.#data,
      this.capacity,
    );
  }

  #claimRole(index: number, name: string): void {
    assertBufferAlive(this.#buffer);
    const owner = this.#buffer.workerId + 1;
    if (Atomics.compareExchange(this.#header, index, 0, owner) !== 0) {
      throw new RangeError(`SpscRingBufferU64 ${name} role is already claimed`);
    }
  }
}

abstract class SpscEndpointU64 implements Disposable {
  readonly #buffer: SharedRingBufferSource;
  readonly #header: Int32Array;
  readonly #roleIndex: number;
  #disposed = false;

  protected constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    roleIndex: number,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.#roleIndex = roleIndex;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  protected assertAlive(): void {
    assertBufferAlive(this.#buffer);
    if (this.#disposed) throw new Error("SpscRingBufferU64 endpoint has been disposed");
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const owner = this.#buffer.workerId + 1;
    Atomics.compareExchange(this.#header, this.#roleIndex, owner, 0);
  }
}

export interface SpscProducerU64 extends Disposable {
  readonly disposed: boolean;
  tryPush(value: bigint): boolean;
  push(value: bigint): void;
  pushAsync(value: bigint): Promise<void>;
  pushMany(values: BigUint64Array): number;
}

class SpscProducerLeaseU64 extends SpscEndpointU64 implements SpscProducerU64 {
  readonly #head: Int32Array;
  readonly #tail: Int32Array;
  readonly #data: Uint32Array;
  readonly #capacity: number;
  readonly #mask: number;

  constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    head: Int32Array,
    tail: Int32Array,
    data: Uint32Array,
    capacity: number,
  ) {
    super(buffer, header, PRODUCER_OWNER_INDEX);
    this.#head = head;
    this.#tail = tail;
    this.#data = data;
    this.#capacity = capacity;
    this.#mask = capacity - 1;
  }

  tryPush(value: bigint): boolean {
    this.assertAlive();
    validateUint64(value);
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    if (((tail - head) >>> 0) >= this.#capacity) return false;
    writeUint64(this.#data, (tail & this.#mask) * 2, value);
    this.#publishTail((tail + 1) >>> 0);
    return true;
  }

  push(value: bigint): void {
    validateUint64(value);
    while (!this.tryPush(value)) {
      const head = Atomics.load(this.#head, COUNTER_INDEX);
      waitForAtomicChangeBlocking(this.#head, COUNTER_INDEX, head, "SpscProducerU64.push");
    }
  }

  async pushAsync(value: bigint): Promise<void> {
    validateUint64(value);
    while (!this.tryPush(value)) {
      const head = Atomics.load(this.#head, COUNTER_INDEX);
      await waitForAtomicChangeAsync(this.#head, COUNTER_INDEX, head);
    }
  }

  pushMany(values: BigUint64Array): number {
    this.assertAlive();
    if (!(values instanceof BigUint64Array)) throw new TypeError("values must be a BigUint64Array");
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const count = Math.min(values.length, this.#capacity - ((tail - head) >>> 0));
    for (let index = 0; index < count; index++) {
      writeUint64(this.#data, ((tail + index) & this.#mask) * 2, values[index]!);
    }
    if (count !== 0) this.#publishTail((tail + count) >>> 0);
    return count;
  }

  #publishTail(next: number): void {
    Atomics.store(this.#tail, COUNTER_INDEX, next);
    Atomics.notify(this.#tail, COUNTER_INDEX, 1);
  }
}

export interface SpscConsumerU64 extends Disposable {
  readonly disposed: boolean;
  tryPop(): bigint | undefined;
  pop(): bigint;
  popAsync(): Promise<bigint>;
  popMany(output: BigUint64Array): number;
}

class SpscConsumerLeaseU64 extends SpscEndpointU64 implements SpscConsumerU64 {
  readonly #head: Int32Array;
  readonly #tail: Int32Array;
  readonly #data: Uint32Array;
  readonly #mask: number;

  constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    head: Int32Array,
    tail: Int32Array,
    data: Uint32Array,
    capacity: number,
  ) {
    super(buffer, header, CONSUMER_OWNER_INDEX);
    this.#head = head;
    this.#tail = tail;
    this.#data = data;
    this.#mask = capacity - 1;
  }

  tryPop(): bigint | undefined {
    this.assertAlive();
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    if (head === tail) return undefined;
    const value = readUint64(this.#data, (head & this.#mask) * 2);
    this.#publishHead((head + 1) >>> 0);
    return value;
  }

  pop(): bigint {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const tail = Atomics.load(this.#tail, COUNTER_INDEX);
      waitForAtomicChangeBlocking(this.#tail, COUNTER_INDEX, tail, "SpscConsumerU64.pop");
    }
  }

  async popAsync(): Promise<bigint> {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const tail = Atomics.load(this.#tail, COUNTER_INDEX);
      await waitForAtomicChangeAsync(this.#tail, COUNTER_INDEX, tail);
    }
  }

  popMany(output: BigUint64Array): number {
    this.assertAlive();
    if (!(output instanceof BigUint64Array)) throw new TypeError("output must be a BigUint64Array");
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const count = Math.min(output.length, (tail - head) >>> 0);
    for (let index = 0; index < count; index++) {
      output[index] = readUint64(this.#data, ((head + index) & this.#mask) * 2);
    }
    if (count !== 0) this.#publishHead((head + count) >>> 0);
    return count;
  }

  #publishHead(next: number): void {
    Atomics.store(this.#head, COUNTER_INDEX, next);
    Atomics.notify(this.#head, COUNTER_INDEX, 1);
  }
}

function writeUint64(data: Uint32Array, index: number, value: bigint): void {
  data[index] = Number(value & 0xffff_ffffn);
  data[index + 1] = Number(value >> 32n);
}

function readUint64(data: Uint32Array, index: number): bigint {
  return BigInt(data[index + 1]!) << 32n | BigInt(data[index]!);
}

function assertBufferAlive(buffer: SharedRingBufferSource): void {
  if (buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
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
