import { SHARED_SYNC_BYTE_LENGTH, SharedMutex, type SharedSyncBuffer } from "./sync.ts";

export const SHARED_BLOCK_SIZES = [256, 1_024, 4_096] as const;
export type SharedBlockSize = (typeof SHARED_BLOCK_SIZES)[number];

const POOL_MAGIC = 0x424c_4b50;
const POOL_ABI_VERSION = 1;
const HEADER_WORDS = SHARED_SYNC_BYTE_LENGTH / Uint32Array.BYTES_PER_ELEMENT;
const CLASS_COUNT = SHARED_BLOCK_SIZES.length;
const CACHE_SLOTS_PER_CLASS = 4;
const CACHE_COUNT_BASE = 0;
const CACHE_SLOT_BASE = CLASS_COUNT;
const MAX_U32 = 0xffff_ffff;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const METADATA_BYTES_INDEX = 2;
const ARENA_START_INDEX = 3;
const ARENA_END_INDEX = 4;
const BUMP_INDEX = 5;
const MAX_WORKERS_INDEX = 6;
const OUTSTANDING_INDEX = 7;
const FREE_HEAD_BASE = 8;

export interface SharedBlockPoolOptions {
  readonly arenaByteOffset?: number;
  readonly arenaByteLength?: number;
}

interface SharedPoolBuffer extends SharedSyncBuffer {
  readonly byteLength: number;
  readonly maxWorkers: number;
  uint8Array(byteOffset?: number, length?: number): Uint8Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
}

export interface SharedBlock extends Disposable {
  readonly byteOffset: number;
  readonly byteLength: SharedBlockSize;
  readonly disposed: boolean;
  uint8Array(byteOffset?: number, length?: number): Uint8Array;
  uint32Array(byteOffset?: number, length?: number): Uint32Array;
}

/** A fixed-size shared block allocator with one local cache per SharedBuffer worker lease. */
export class SharedBlockPool {
  readonly byteOffset: number;
  readonly metadataByteLength: number;
  readonly arenaStart: number;
  readonly arenaEnd: number;
  readonly #buffer: SharedPoolBuffer;
  readonly #header: Uint32Array;
  readonly #cache: Uint32Array;
  readonly #locks: readonly SharedMutex[];

  private constructor(
    buffer: SharedPoolBuffer,
    byteOffset: number,
    metadataByteLength: number,
    arenaStart: number,
    arenaEnd: number,
    header: Uint32Array,
    locks: readonly SharedMutex[],
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.metadataByteLength = metadataByteLength;
    this.arenaStart = arenaStart;
    this.arenaEnd = arenaEnd;
    this.#header = header;
    this.#locks = locks;
    this.#cache = buffer.uint32Array(this.#workerCacheOffset(buffer.workerId), HEADER_WORDS);
  }

  static metadataByteLength(maxWorkers: number): number {
    validatePositiveInteger(maxWorkers, "maxWorkers");
    return (1 + CLASS_COUNT + maxWorkers) * SHARED_SYNC_BYTE_LENGTH;
  }

  /** Initializes allocator metadata before the buffer is published to Workers. */
  static initialize(
    buffer: SharedPoolBuffer,
    byteOffset: number,
    options: SharedBlockPoolOptions = {},
  ): SharedBlockPool {
    validatePoolOffset(byteOffset);
    const metadataByteLength = SharedBlockPool.metadataByteLength(buffer.maxWorkers);
    const metadataEnd = byteOffset + metadataByteLength;
    const arenaStart = options.arenaByteOffset ?? alignTo(metadataEnd, 4_096);
    validateArenaOffset(arenaStart, metadataEnd, buffer.byteLength);
    const arenaByteLength = options.arenaByteLength ?? buffer.byteLength - arenaStart;
    validateNonNegativeInteger(arenaByteLength, "arenaByteLength");
    const arenaEnd = arenaStart + arenaByteLength;
    if (!Number.isSafeInteger(arenaEnd) || arenaEnd > buffer.byteLength || arenaEnd > MAX_U32) {
      throw new RangeError("shared block arena is out of bounds");
    }

    const metadata = buffer.uint32Array(byteOffset, metadataByteLength / 4);
    metadata.fill(0);
    const locks = SHARED_BLOCK_SIZES.map((_, classIndex) =>
      SharedMutex.initialize(
        buffer,
        byteOffset + SHARED_SYNC_BYTE_LENGTH * (1 + classIndex),
      )
    );
    const header = metadata.subarray(0, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, POOL_ABI_VERSION);
    Atomics.store(header, METADATA_BYTES_INDEX, metadataByteLength);
    Atomics.store(header, ARENA_START_INDEX, arenaStart);
    Atomics.store(header, ARENA_END_INDEX, arenaEnd);
    Atomics.store(header, BUMP_INDEX, arenaStart);
    Atomics.store(header, MAX_WORKERS_INDEX, buffer.maxWorkers);
    Atomics.store(header, OUTSTANDING_INDEX, 0);
    Atomics.store(header, MAGIC_INDEX, POOL_MAGIC);
    return new SharedBlockPool(
      buffer,
      byteOffset,
      metadataByteLength,
      arenaStart,
      arenaEnd,
      header,
      locks,
    );
  }

  static attach(buffer: SharedPoolBuffer, byteOffset: number): SharedBlockPool {
    validatePoolOffset(byteOffset);
    const header = buffer.uint32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== POOL_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized SharedBlockPool");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== POOL_ABI_VERSION) {
      throw new RangeError(`unsupported SharedBlockPool ABI version: ${version}`);
    }
    const maxWorkers = Atomics.load(header, MAX_WORKERS_INDEX);
    if (maxWorkers !== buffer.maxWorkers) {
      throw new RangeError("SharedBlockPool worker capacity does not match SharedBuffer");
    }
    const metadataByteLength = Atomics.load(header, METADATA_BYTES_INDEX);
    if (metadataByteLength !== SharedBlockPool.metadataByteLength(maxWorkers)) {
      throw new RangeError("invalid SharedBlockPool metadata size");
    }
    const arenaStart = Atomics.load(header, ARENA_START_INDEX);
    const arenaEnd = Atomics.load(header, ARENA_END_INDEX);
    validateArenaOffset(arenaStart, byteOffset + metadataByteLength, buffer.byteLength);
    if (arenaEnd < arenaStart || arenaEnd > buffer.byteLength) {
      throw new RangeError("invalid SharedBlockPool arena bounds");
    }
    const bump = Atomics.load(header, BUMP_INDEX);
    if (bump < arenaStart || bump > arenaEnd) {
      throw new RangeError("invalid SharedBlockPool bump pointer");
    }
    const locks = SHARED_BLOCK_SIZES.map((_, classIndex) =>
      SharedMutex.attach(buffer, byteOffset + SHARED_SYNC_BYTE_LENGTH * (1 + classIndex))
    );
    return new SharedBlockPool(
      buffer,
      byteOffset,
      metadataByteLength,
      arenaStart,
      arenaEnd,
      header,
      locks,
    );
  }

  get outstandingBlocks(): number {
    this.#assertAlive();
    return Atomics.load(this.#header, OUTSTANDING_INDEX);
  }

  get reservedBytes(): number {
    this.#assertAlive();
    return Atomics.load(this.#header, BUMP_INDEX) - this.arenaStart;
  }

  get arenaByteLength(): number {
    return this.arenaEnd - this.arenaStart;
  }

  allocate(size: SharedBlockSize): SharedBlock {
    const block = this.tryAllocate(size);
    if (block === undefined) throw new RangeError(`SharedBlockPool ${size}-byte arena exhausted`);
    return block;
  }

  tryAllocate(size: SharedBlockSize): SharedBlock | undefined {
    this.#assertAlive();
    const classIndex = classIndexOf(size);
    let pointer = this.#popLocal(classIndex);
    if (pointer === 0) pointer = this.#refillFromGlobal(classIndex);
    if (pointer === 0) pointer = this.#allocateFromArena(size);
    if (pointer === 0) return undefined;
    Atomics.add(this.#header, OUTSTANDING_INDEX, 1);
    return new SharedBlockLease(
      this.#buffer,
      pointer,
      size,
      () => this.#release(pointer, size, classIndex),
    );
  }

  #popLocal(classIndex: number): number {
    const countIndex = CACHE_COUNT_BASE + classIndex;
    const count = this.#cache[countIndex]!;
    if (count === 0) return 0;
    const slotIndex = cacheSlotIndex(classIndex, count - 1);
    const pointer = this.#cache[slotIndex]!;
    this.#cache[slotIndex] = 0;
    this.#cache[countIndex] = count - 1;
    return pointer;
  }

  #refillFromGlobal(classIndex: number): number {
    const lock = this.#locks[classIndex]!;
    lock.lock();
    try {
      let head = Atomics.load(this.#header, FREE_HEAD_BASE + classIndex);
      if (head === 0) return 0;
      const result = head;
      head = this.#nextFree(head);
      let cached = 0;
      while (head !== 0 && cached < CACHE_SLOTS_PER_CLASS) {
        const pointer = head;
        head = this.#nextFree(pointer);
        this.#cache[cacheSlotIndex(classIndex, cached)] = pointer;
        cached++;
      }
      this.#cache[CACHE_COUNT_BASE + classIndex] = cached;
      Atomics.store(this.#header, FREE_HEAD_BASE + classIndex, head);
      return result;
    } finally {
      lock.unlock();
    }
  }

  #allocateFromArena(size: SharedBlockSize): number {
    while (true) {
      const current = Atomics.load(this.#header, BUMP_INDEX);
      const pointer = alignTo(current, size);
      const next = pointer + size;
      if (next > this.arenaEnd || next > MAX_U32) return 0;
      if (Atomics.compareExchange(this.#header, BUMP_INDEX, current, next) === current) {
        return pointer;
      }
    }
  }

  #release(pointer: number, size: SharedBlockSize, classIndex: number): void {
    this.#assertAlive();
    validateBlockPointer(pointer, size, this.arenaStart, this.arenaEnd);
    const countIndex = CACHE_COUNT_BASE + classIndex;
    let count = this.#cache[countIndex]!;
    if (count === CACHE_SLOTS_PER_CLASS) {
      const lock = this.#locks[classIndex]!;
      lock.lock();
      try {
        let head = Atomics.load(this.#header, FREE_HEAD_BASE + classIndex);
        for (let index = 0; index < count; index++) {
          const slotIndex = cacheSlotIndex(classIndex, index);
          const cachedPointer = this.#cache[slotIndex]!;
          this.#setNextFree(cachedPointer, head);
          head = cachedPointer;
          this.#cache[slotIndex] = 0;
        }
        Atomics.store(this.#header, FREE_HEAD_BASE + classIndex, head);
      } finally {
        lock.unlock();
      }
      count = 0;
    }
    this.#cache[cacheSlotIndex(classIndex, count)] = pointer;
    this.#cache[countIndex] = count + 1;
    const previous = Atomics.sub(this.#header, OUTSTANDING_INDEX, 1);
    if (previous === 0) {
      Atomics.add(this.#header, OUTSTANDING_INDEX, 1);
      throw new Error("SharedBlockPool outstanding block count underflow");
    }
  }

  #nextFree(pointer: number): number {
    return this.#buffer.uint32Array(pointer, 1)[0]!;
  }

  #setNextFree(pointer: number, next: number): void {
    this.#buffer.uint32Array(pointer, 1)[0] = next;
  }

  #workerCacheOffset(workerId: number): number {
    return this.byteOffset + SHARED_SYNC_BYTE_LENGTH * (1 + CLASS_COUNT + workerId);
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class SharedBlockLease implements SharedBlock {
  readonly byteOffset: number;
  readonly byteLength: SharedBlockSize;
  readonly #buffer: SharedPoolBuffer;
  readonly #release: () => void;
  #disposed = false;

  constructor(
    buffer: SharedPoolBuffer,
    byteOffset: number,
    byteLength: SharedBlockSize,
    release: () => void,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.#release = release;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  uint8Array(byteOffset = 0, length = this.byteLength - byteOffset): Uint8Array {
    this.#assertAlive();
    validateBlockRange(byteOffset, length, this.byteLength, 1);
    return this.#buffer.uint8Array(this.byteOffset + byteOffset, length);
  }

  uint32Array(byteOffset = 0, length = (this.byteLength - byteOffset) / 4): Uint32Array {
    this.#assertAlive();
    if ((byteOffset & 3) !== 0) throw new RangeError("Uint32 byteOffset must be 4-byte aligned");
    validateBlockRange(byteOffset, length, this.byteLength, 4);
    return this.#buffer.uint32Array(this.byteOffset + byteOffset, length);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SharedBlock lease has been disposed");
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

function classIndexOf(size: SharedBlockSize): number {
  const index = SHARED_BLOCK_SIZES.indexOf(size);
  if (index < 0) {
    throw new RangeError(`size must be one of ${SHARED_BLOCK_SIZES.join(", ")}`);
  }
  return index;
}

function cacheSlotIndex(classIndex: number, slot: number): number {
  return CACHE_SLOT_BASE + classIndex * CACHE_SLOTS_PER_CLASS + slot;
}

function validatePoolOffset(byteOffset: number): void {
  validateNonNegativeInteger(byteOffset, "byteOffset");
  if (byteOffset % SHARED_SYNC_BYTE_LENGTH !== 0) {
    throw new RangeError(`byteOffset must be ${SHARED_SYNC_BYTE_LENGTH}-byte aligned`);
  }
}

function validateArenaOffset(value: number, minimum: number, bufferByteLength: number): void {
  validateNonNegativeInteger(value, "arenaByteOffset");
  if (value % 256 !== 0) throw new RangeError("arenaByteOffset must be 256-byte aligned");
  if (value < minimum || value > bufferByteLength || value > MAX_U32) {
    throw new RangeError("arenaByteOffset overlaps metadata or exceeds shared memory");
  }
}

function validateBlockPointer(
  pointer: number,
  size: SharedBlockSize,
  arenaStart: number,
  arenaEnd: number,
): void {
  if (pointer < arenaStart || pointer + size > arenaEnd || pointer % size !== 0) {
    throw new RangeError("invalid SharedBlock pointer");
  }
}

function validateBlockRange(
  byteOffset: number,
  length: number,
  blockByteLength: number,
  elementBytes: number,
): void {
  validateNonNegativeInteger(byteOffset, "byteOffset");
  validateNonNegativeInteger(length, "length");
  const byteLength = length * elementBytes;
  if (!Number.isSafeInteger(byteLength) || byteOffset + byteLength > blockByteLength) {
    throw new RangeError("SharedBlock view is out of bounds");
  }
}

function validatePositiveInteger(value: number, name: string): void {
  validateNonNegativeInteger(value, name);
  if (value === 0) throw new RangeError(`${name} must be positive`);
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
