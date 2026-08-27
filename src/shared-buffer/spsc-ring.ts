import { waitForAtomicChangeAsync, waitForAtomicChangeBlocking } from "./sync.ts";

export const SPSC_RING_CACHE_LINE_BYTES = 64;

const RING_MAGIC = 0x5350_5343;
const RING_ABI_VERSION = 1;
const HEADER_WORDS = SPSC_RING_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const HEAD_BYTE_OFFSET = SPSC_RING_CACHE_LINE_BYTES;
const TAIL_BYTE_OFFSET = SPSC_RING_CACHE_LINE_BYTES * 2;
const DATA_BYTE_OFFSET = SPSC_RING_CACHE_LINE_BYTES * 3;
const MAX_CAPACITY = 0x4000_0000;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const BYTE_LENGTH_INDEX = 3;
const DATA_OFFSET_INDEX = 4;
const PRODUCER_OWNER_INDEX = 5;
const CONSUMER_OWNER_INDEX = 6;
const COUNTER_INDEX = 0;

/** The shared-memory operations required by the SPSC ring. */
export interface SharedRingBufferSource {
  readonly workerId: number;
  readonly disposed: boolean;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
  copyBytesNonOverlapping(
    destinationByteOffset: number,
    sourceByteOffset: number,
    length: number,
  ): unknown;
}

/** A fixed-capacity single-producer/single-consumer queue of unsigned 32-bit handles. */
export class SpscRingBufferU32 {
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
    this.#data = buffer.uint32Array(this.dataByteOffset, capacity);
  }

  static byteLengthFor(capacity: number): number {
    validateCapacity(capacity);
    return alignTo(DATA_BYTE_OFFSET + capacity * Uint32Array.BYTES_PER_ELEMENT, 64);
  }

  /** Initializes the ring before its SharedBuffer is published to another Worker. */
  static initialize(
    buffer: SharedRingBufferSource,
    byteOffset: number,
    capacity: number,
  ): SpscRingBufferU32 {
    validateByteOffset(byteOffset);
    const byteLength = SpscRingBufferU32.byteLengthFor(capacity);
    const words = buffer.uint32Array(byteOffset, byteLength / Uint32Array.BYTES_PER_ELEMENT);
    words.fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, RING_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, capacity);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, DATA_OFFSET_INDEX, DATA_BYTE_OFFSET);
    Atomics.store(header, MAGIC_INDEX, RING_MAGIC);
    return new SpscRingBufferU32(buffer, byteOffset, capacity, byteLength, header);
  }

  static attach(buffer: SharedRingBufferSource, byteOffset: number): SpscRingBufferU32 {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== RING_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized SpscRingBufferU32");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== RING_ABI_VERSION) {
      throw new RangeError(`unsupported SpscRingBufferU32 ABI version: ${version}`);
    }
    const capacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    validateCapacity(capacity);
    const byteLength = Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0;
    if (
      byteLength !== SpscRingBufferU32.byteLengthFor(capacity) ||
      Atomics.load(header, DATA_OFFSET_INDEX) !== DATA_BYTE_OFFSET
    ) {
      throw new RangeError("invalid SpscRingBufferU32 layout");
    }
    buffer.uint32Array(byteOffset, byteLength / Uint32Array.BYTES_PER_ELEMENT);
    return new SpscRingBufferU32(buffer, byteOffset, capacity, byteLength, header);
  }

  producer(): SpscProducerU32 {
    this.#claimRole(PRODUCER_OWNER_INDEX, "producer");
    return new SpscProducerLeaseU32(
      this.#buffer,
      this.#header,
      this.#head,
      this.#tail,
      this.#data,
      this.dataByteOffset,
      this.capacity,
    );
  }

  consumer(): SpscConsumerU32 {
    this.#claimRole(CONSUMER_OWNER_INDEX, "consumer");
    return new SpscConsumerLeaseU32(
      this.#buffer,
      this.#header,
      this.#head,
      this.#tail,
      this.#data,
      this.dataByteOffset,
      this.capacity,
    );
  }

  #claimRole(index: number, name: string): void {
    assertBufferAlive(this.#buffer);
    const owner = this.#buffer.workerId + 1;
    if (Atomics.compareExchange(this.#header, index, 0, owner) !== 0) {
      throw new RangeError(`SpscRingBufferU32 ${name} role is already claimed`);
    }
  }
}

abstract class SpscEndpointU32 implements Disposable {
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
    if (this.#disposed) throw new Error("SpscRingBufferU32 endpoint has been disposed");
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const owner = this.#buffer.workerId + 1;
    Atomics.compareExchange(this.#header, this.#roleIndex, owner, 0);
  }
}

/** The exclusive producer role. Dispose it with `using` to release the role. */
export interface SpscProducerU32 extends Disposable {
  readonly disposed: boolean;
  tryPush(value: number): boolean;
  push(value: number): void;
  pushAsync(value: number): Promise<void>;
  pushMany(values: Uint32Array): number;
  pushManyFromShared(sourceByteOffset: number, count: number): number;
}

class SpscProducerLeaseU32 extends SpscEndpointU32 implements SpscProducerU32 {
  readonly #buffer: SharedRingBufferSource;
  readonly #head: Int32Array;
  readonly #tail: Int32Array;
  readonly #data: Uint32Array;
  readonly #dataByteOffset: number;
  readonly #capacity: number;
  readonly #mask: number;

  constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    head: Int32Array,
    tail: Int32Array,
    data: Uint32Array,
    dataByteOffset: number,
    capacity: number,
  ) {
    super(buffer, header, PRODUCER_OWNER_INDEX);
    this.#buffer = buffer;
    this.#head = head;
    this.#tail = tail;
    this.#data = data;
    this.#dataByteOffset = dataByteOffset;
    this.#capacity = capacity;
    this.#mask = capacity - 1;
  }

  tryPush(value: number): boolean {
    this.assertAlive();
    validateUint32(value);
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    if (((tail - head) >>> 0) >= this.#capacity) return false;
    this.#data[tail & this.#mask] = value;
    this.#publishTail((tail + 1) >>> 0);
    return true;
  }

  /** Blocks a Worker until the value can be written. */
  push(value: number): void {
    validateUint32(value);
    while (!this.tryPush(value)) {
      const head = Atomics.load(this.#head, COUNTER_INDEX);
      waitForAtomicChangeBlocking(this.#head, COUNTER_INDEX, head, "SpscProducerU32.push");
    }
  }

  async pushAsync(value: number): Promise<void> {
    validateUint32(value);
    while (!this.tryPush(value)) {
      const head = Atomics.load(this.#head, COUNTER_INDEX);
      await waitForAtomicChangeAsync(this.#head, COUNTER_INDEX, head);
    }
  }

  pushMany(values: Uint32Array): number {
    this.assertAlive();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const count = Math.min(values.length, this.#capacity - ((tail - head) >>> 0));
    this.#copyFromArray(values, count, tail);
    if (count !== 0) this.#publishTail((tail + count) >>> 0);
    return count;
  }

  /** Copies handles already stored in the same SharedBuffer through the SIMD copy kernel. */
  pushManyFromShared(sourceByteOffset: number, count: number): number {
    this.assertAlive();
    validateCount(count);
    validateExternalRange(
      this.#buffer,
      sourceByteOffset,
      count,
      this.#dataByteOffset,
      this.#capacity,
    );
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const copied = Math.min(count, this.#capacity - ((tail - head) >>> 0));
    this.#copyFromShared(sourceByteOffset, copied, tail);
    if (copied !== 0) this.#publishTail((tail + copied) >>> 0);
    return copied;
  }

  #copyFromArray(values: Uint32Array, count: number, tail: number): void {
    if (count === 0) return;
    const start = tail & this.#mask;
    const first = Math.min(count, this.#capacity - start);
    this.#data.set(values.subarray(0, first), start);
    if (first !== count) this.#data.set(values.subarray(first, count), 0);
  }

  #copyFromShared(sourceByteOffset: number, count: number, tail: number): void {
    if (count === 0) return;
    const start = tail & this.#mask;
    const first = Math.min(count, this.#capacity - start);
    this.#buffer.copyBytesNonOverlapping(
      this.#dataByteOffset + start * 4,
      sourceByteOffset,
      first * 4,
    );
    if (first !== count) {
      this.#buffer.copyBytesNonOverlapping(
        this.#dataByteOffset,
        sourceByteOffset + first * 4,
        (count - first) * 4,
      );
    }
  }

  #publishTail(next: number): void {
    Atomics.store(this.#tail, COUNTER_INDEX, next);
    Atomics.notify(this.#tail, COUNTER_INDEX, 1);
  }
}

/** The exclusive consumer role. Dispose it with `using` to release the role. */
export interface SpscConsumerU32 extends Disposable {
  readonly disposed: boolean;
  tryPop(): number | undefined;
  pop(): number;
  popAsync(): Promise<number>;
  popMany(output: Uint32Array): number;
  popManyToShared(destinationByteOffset: number, count: number): number;
}

class SpscConsumerLeaseU32 extends SpscEndpointU32 implements SpscConsumerU32 {
  readonly #buffer: SharedRingBufferSource;
  readonly #head: Int32Array;
  readonly #tail: Int32Array;
  readonly #data: Uint32Array;
  readonly #dataByteOffset: number;
  readonly #capacity: number;
  readonly #mask: number;

  constructor(
    buffer: SharedRingBufferSource,
    header: Int32Array,
    head: Int32Array,
    tail: Int32Array,
    data: Uint32Array,
    dataByteOffset: number,
    capacity: number,
  ) {
    super(buffer, header, CONSUMER_OWNER_INDEX);
    this.#buffer = buffer;
    this.#head = head;
    this.#tail = tail;
    this.#data = data;
    this.#dataByteOffset = dataByteOffset;
    this.#capacity = capacity;
    this.#mask = capacity - 1;
  }

  tryPop(): number | undefined {
    this.assertAlive();
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    if (head === tail) return undefined;
    const value = this.#data[head & this.#mask]!;
    this.#publishHead((head + 1) >>> 0);
    return value;
  }

  /** Blocks a Worker until a value is available. */
  pop(): number {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const tail = Atomics.load(this.#tail, COUNTER_INDEX);
      waitForAtomicChangeBlocking(this.#tail, COUNTER_INDEX, tail, "SpscConsumerU32.pop");
    }
  }

  async popAsync(): Promise<number> {
    while (true) {
      const value = this.tryPop();
      if (value !== undefined) return value;
      const tail = Atomics.load(this.#tail, COUNTER_INDEX);
      await waitForAtomicChangeAsync(this.#tail, COUNTER_INDEX, tail);
    }
  }

  popMany(output: Uint32Array): number {
    this.assertAlive();
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const count = Math.min(output.length, (tail - head) >>> 0);
    this.#copyToArray(output, count, head);
    if (count !== 0) this.#publishHead((head + count) >>> 0);
    return count;
  }

  /** Copies handles to another region in the same SharedBuffer through the SIMD copy kernel. */
  popManyToShared(destinationByteOffset: number, count: number): number {
    this.assertAlive();
    validateCount(count);
    validateExternalRange(
      this.#buffer,
      destinationByteOffset,
      count,
      this.#dataByteOffset,
      this.#capacity,
    );
    const head = Atomics.load(this.#head, COUNTER_INDEX) >>> 0;
    const tail = Atomics.load(this.#tail, COUNTER_INDEX) >>> 0;
    const copied = Math.min(count, (tail - head) >>> 0);
    this.#copyToShared(destinationByteOffset, copied, head);
    if (copied !== 0) this.#publishHead((head + copied) >>> 0);
    return copied;
  }

  #copyToArray(output: Uint32Array, count: number, head: number): void {
    if (count === 0) return;
    const start = head & this.#mask;
    const first = Math.min(count, this.#capacity - start);
    output.set(this.#data.subarray(start, start + first), 0);
    if (first !== count) output.set(this.#data.subarray(0, count - first), first);
  }

  #copyToShared(destinationByteOffset: number, count: number, head: number): void {
    if (count === 0) return;
    const start = head & this.#mask;
    const first = Math.min(count, this.#capacity - start);
    this.#buffer.copyBytesNonOverlapping(
      destinationByteOffset,
      this.#dataByteOffset + start * 4,
      first * 4,
    );
    if (first !== count) {
      this.#buffer.copyBytesNonOverlapping(
        destinationByteOffset + first * 4,
        this.#dataByteOffset,
        (count - first) * 4,
      );
    }
  }

  #publishHead(next: number): void {
    Atomics.store(this.#head, COUNTER_INDEX, next);
    Atomics.notify(this.#head, COUNTER_INDEX, 1);
  }
}

function assertBufferAlive(buffer: SharedRingBufferSource): void {
  if (buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % SPSC_RING_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${SPSC_RING_CACHE_LINE_BYTES}-byte aligned`);
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

function validateUint32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
}

function validateCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("count must be a non-negative safe integer");
  }
}

function validateExternalRange(
  buffer: SharedRingBufferSource,
  byteOffset: number,
  count: number,
  dataByteOffset: number,
  capacity: number,
): void {
  if ((byteOffset & 3) !== 0) throw new RangeError("byteOffset must be 4-byte aligned");
  buffer.uint32Array(byteOffset, count);
  const byteLength = count * Uint32Array.BYTES_PER_ELEMENT;
  const dataByteLength = capacity * Uint32Array.BYTES_PER_ELEMENT;
  if (
    byteLength !== 0 && byteOffset < dataByteOffset + dataByteLength &&
    dataByteOffset < byteOffset + byteLength
  ) {
    throw new RangeError("shared transfer range must not overlap the ring data");
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
