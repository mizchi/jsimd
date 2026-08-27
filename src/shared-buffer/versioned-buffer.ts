import {
  releaseSharedOwner,
  type SharedOwnershipBuffer,
  tryClaimSharedOwner,
} from "./ownership.ts";

export const VERSIONED_BUFFER_CACHE_LINE_BYTES = 64;

const VERSIONED_BUFFER_MAGIC = 0x5652_4246;
const VERSIONED_BUFFER_ABI_VERSION = 1;
const HEADER_BYTES = VERSIONED_BUFFER_CACHE_LINE_BYTES * 3;
const HEADER_WORDS = HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT;
const MAX_GENERATION = 0x3fff_ffff;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const SLOT_STRIDE_INDEX = 3;
const BYTE_LENGTH_INDEX = 4;
const STATE_INDEX = 5;
const WRITER_OWNER_INDEX = 6;

export interface VersionedBufferBacking extends SharedOwnershipBuffer {
  readonly workerId: number;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint8Array(byteOffset?: number, length?: number): Uint8Array;
}

export interface VersionedBufferSnapshot extends Disposable {
  readonly generation: number;
  readonly byteCapacity: number;
  readonly disposed: boolean;
  /** Read-only by contract. The typed-array type itself cannot prevent mutation. */
  readonly bytes: Uint8Array;
}

export interface VersionedBufferWriter extends Disposable {
  readonly byteCapacity: number;
  readonly disposed: boolean;
  readonly published: boolean;
  readonly bytes: Uint8Array;
  publish(): number;
}

/** Double-buffered immutable publication with guarded reader-safe slot reuse. */
export class VersionedBuffer {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly byteCapacity: number;
  readonly slotStride: number;
  readonly #buffer: VersionedBufferBacking;
  readonly #header: Int32Array;
  readonly #readers: readonly [Int32Array, Int32Array];

  private constructor(
    buffer: VersionedBufferBacking,
    byteOffset: number,
    byteCapacity: number,
    slotStride: number,
    byteLength: number,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + HEADER_BYTES;
    this.byteCapacity = byteCapacity;
    this.slotStride = slotStride;
    this.#readers = [
      buffer.int32Array(byteOffset + VERSIONED_BUFFER_CACHE_LINE_BYTES, 1),
      buffer.int32Array(byteOffset + VERSIONED_BUFFER_CACHE_LINE_BYTES * 2, 1),
    ];
  }

  static byteLengthFor(byteCapacity: number): number {
    const slotStride = validateByteCapacity(byteCapacity);
    return HEADER_BYTES + slotStride * 2;
  }

  static initialize(
    buffer: VersionedBufferBacking,
    byteOffset: number,
    byteCapacity: number,
  ): VersionedBuffer {
    validateByteOffset(byteOffset);
    const slotStride = validateByteCapacity(byteCapacity);
    const byteLength = HEADER_BYTES + slotStride * 2;
    buffer.uint8Array(byteOffset, byteLength).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, VERSIONED_BUFFER_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, byteCapacity);
    Atomics.store(header, SLOT_STRIDE_INDEX, slotStride);
    Atomics.store(header, BYTE_LENGTH_INDEX, byteLength);
    Atomics.store(header, STATE_INDEX, 0);
    Atomics.store(header, WRITER_OWNER_INDEX, 0);
    Atomics.store(header, MAGIC_INDEX, VERSIONED_BUFFER_MAGIC);
    return new VersionedBuffer(
      buffer,
      byteOffset,
      byteCapacity,
      slotStride,
      byteLength,
      header,
    );
  }

  static attach(buffer: VersionedBufferBacking, byteOffset: number): VersionedBuffer {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== VERSIONED_BUFFER_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized VersionedBuffer");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== VERSIONED_BUFFER_ABI_VERSION) {
      throw new RangeError(`unsupported VersionedBuffer ABI version: ${version}`);
    }
    const byteCapacity = Atomics.load(header, CAPACITY_INDEX) >>> 0;
    const slotStride = validateByteCapacity(byteCapacity);
    const byteLength = HEADER_BYTES + slotStride * 2;
    if (
      (Atomics.load(header, SLOT_STRIDE_INDEX) >>> 0) !== slotStride ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== byteLength
    ) {
      throw new RangeError("invalid VersionedBuffer layout");
    }
    buffer.uint8Array(byteOffset, byteLength);
    return new VersionedBuffer(
      buffer,
      byteOffset,
      byteCapacity,
      slotStride,
      byteLength,
      header,
    );
  }

  acquire(): VersionedBufferSnapshot {
    this.#assertAlive();
    while (true) {
      const state = Atomics.load(this.#header, STATE_INDEX) >>> 0;
      const slot = state & 1;
      const readers = this.#readers[slot as 0 | 1];
      const previous = Atomics.add(readers, 0, 1);
      if (previous < 0 || previous === 0x7fff_ffff) {
        Atomics.sub(readers, 0, 1);
        throw new RangeError("VersionedBuffer reader count overflow");
      }
      if ((Atomics.load(this.#header, STATE_INDEX) >>> 0) === state) {
        const bytes = this.#buffer.uint8Array(
          this.dataByteOffset + slot * this.slotStride,
          this.byteCapacity,
        );
        return new SnapshotGuard(this.#buffer, readers, state >>> 1, this.byteCapacity, bytes);
      }
      Atomics.sub(readers, 0, 1);
      Atomics.notify(readers, 0, 1);
    }
  }

  beginWrite(): VersionedBufferWriter {
    const writer = this.tryBeginWrite();
    if (writer === undefined) {
      throw new RangeError("VersionedBuffer has no writable inactive slot");
    }
    return writer;
  }

  tryBeginWrite(): VersionedBufferWriter | undefined {
    this.#assertAlive();
    if (!tryClaimSharedOwner(this.#buffer, this.#header, WRITER_OWNER_INDEX)) {
      return undefined;
    }
    const state = Atomics.load(this.#header, STATE_INDEX) >>> 0;
    const slot = 1 - (state & 1);
    if (Atomics.load(this.#readers[slot as 0 | 1], 0) !== 0) {
      releaseSharedOwner(this.#buffer, this.#header, WRITER_OWNER_INDEX);
      Atomics.notify(this.#header, WRITER_OWNER_INDEX, 1);
      return undefined;
    }
    return new WriterLease(
      this.#buffer,
      this.#header,
      this.#buffer.leaseToken,
      state,
      this.byteCapacity,
      this.#buffer.uint8Array(
        this.dataByteOffset + slot * this.slotStride,
        this.byteCapacity,
      ),
    );
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class SnapshotGuard implements VersionedBufferSnapshot {
  readonly generation: number;
  readonly byteCapacity: number;
  readonly #buffer: VersionedBufferBacking;
  readonly #readers: Int32Array;
  readonly #bytes: Uint8Array;
  #disposed = false;

  constructor(
    buffer: VersionedBufferBacking,
    readers: Int32Array,
    generation: number,
    byteCapacity: number,
    bytes: Uint8Array,
  ) {
    this.#buffer = buffer;
    this.#readers = readers;
    this.generation = generation;
    this.byteCapacity = byteCapacity;
    this.#bytes = bytes;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get bytes(): Uint8Array {
    this.#assertAlive();
    return this.#bytes;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Atomics.sub(this.#readers, 0, 1);
    Atomics.notify(this.#readers, 0);
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (this.#disposed) throw new Error("VersionedBuffer snapshot has been disposed");
  }
}

class WriterLease implements VersionedBufferWriter {
  readonly byteCapacity: number;
  readonly #buffer: VersionedBufferBacking;
  readonly #header: Int32Array;
  readonly #owner: number;
  readonly #state: number;
  readonly #bytes: Uint8Array;
  #disposed = false;
  #published = false;

  constructor(
    buffer: VersionedBufferBacking,
    header: Int32Array,
    owner: number,
    state: number,
    byteCapacity: number,
    bytes: Uint8Array,
  ) {
    this.#buffer = buffer;
    this.#header = header;
    this.#owner = owner;
    this.#state = state;
    this.byteCapacity = byteCapacity;
    this.#bytes = bytes;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get published(): boolean {
    return this.#published;
  }

  get bytes(): Uint8Array {
    this.#assertAlive();
    return this.#bytes;
  }

  publish(): number {
    this.#assertAlive();
    if ((Atomics.load(this.#header, STATE_INDEX) >>> 0) !== this.#state) {
      throw new Error("VersionedBuffer publication state changed unexpectedly");
    }
    const generation = ((this.#state >>> 1) + 1) & MAX_GENERATION;
    const slot = 1 - (this.#state & 1);
    Atomics.store(this.#header, STATE_INDEX, generation << 1 | slot);
    Atomics.notify(this.#header, STATE_INDEX);
    this.#published = true;
    this[Symbol.dispose]();
    return generation;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseSharedOwner(this.#buffer, this.#header, WRITER_OWNER_INDEX);
    Atomics.notify(this.#header, WRITER_OWNER_INDEX, 1);
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
    if (this.#disposed || Atomics.load(this.#header, WRITER_OWNER_INDEX) !== this.#owner) {
      throw new Error("VersionedBuffer writer lease has been disposed or lost ownership");
    }
  }
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % VERSIONED_BUFFER_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${VERSIONED_BUFFER_CACHE_LINE_BYTES}-byte aligned`);
  }
}

function validateByteCapacity(byteCapacity: number): number {
  if (!Number.isSafeInteger(byteCapacity) || byteCapacity < 1 || byteCapacity > 0xffff_ffff) {
    throw new RangeError("byteCapacity must be a positive unsigned 32-bit integer");
  }
  const stride = alignTo(
    Math.max(VERSIONED_BUFFER_CACHE_LINE_BYTES, byteCapacity),
    VERSIONED_BUFFER_CACHE_LINE_BYTES,
  );
  if (!Number.isSafeInteger(HEADER_BYTES + stride * 2)) {
    throw new RangeError("VersionedBuffer layout exceeds the safe integer range");
  }
  return stride;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
