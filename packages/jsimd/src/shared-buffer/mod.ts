export const SHARED_BUFFER_ABI_VERSION = 2;
export const SHARED_BUFFER_CACHE_LINE_BYTES = 64;
export const SHARED_BUFFER_ALIGNMENT = 16;

const MAGIC = 0x4a53_494d;
const MAGIC_INDEX = 0;
const ABI_VERSION_INDEX = 1;
const HEADER_BYTES_INDEX = 2;
const MAXIMUM_PAGES_INDEX = 3;
const MAX_WORKERS_INDEX = 4;
const ACTIVE_WORKERS_INDEX = 5;
const READY_INDEX = 6;
const FIXED_HEADER_BYTES = SHARED_BUFFER_CACHE_LINE_BYTES;
const WORKER_SLOT_BYTES = SHARED_BUFFER_CACHE_LINE_BYTES;
const WORKER_LEASE_INDEX = 0;
const WORKER_GENERATION_INDEX = 1;
const WORKER_ID_BITS = 8;
const WORKER_ID_MASK = (1 << WORKER_ID_BITS) - 1;
const MAX_WORKER_GENERATION = 0x7f_ffff;
const HEADER_WORDS = FIXED_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT;
const MAXIMUM_WASM_PAGES = 65_536;

interface SharedBufferKernels extends WebAssembly.Exports {
  fill_u32(pointer: number, length: number, value: number): void;
  copy_bytes(destination: number, source: number, length: number): void;
  reduce_shards_or(
    destination: number,
    source: number,
    shardCount: number,
    shardStride: number,
    words: number,
  ): void;
  reduce_shards_and(
    destination: number,
    source: number,
    shardCount: number,
    shardStride: number,
    words: number,
  ): void;
  reduce_shards_sum_u32(
    destination: number,
    source: number,
    shardCount: number,
    shardStride: number,
    words: number,
  ): void;
}

export interface SharedBufferOptions {
  readonly initialPages?: number;
  readonly maximumPages?: number;
  readonly maxWorkers?: number;
}

/** Opaque proof that a particular generation owned a worker slot. */
export interface SharedWorkerLease {
  readonly workerId: number;
  readonly leaseToken: number;
}

/** Returns whether this runtime can construct shared WebAssembly linear memory. */
export function supportsSharedWebAssemblyMemory(): boolean {
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}

/** Instantiates a compiled Wasm module against an explicitly supplied shared memory. */
export function instantiateSharedModule<T extends WebAssembly.Exports>(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  imports: WebAssembly.Imports = {},
): T {
  validateSharedMemory(memory);
  const namespace = imports.jsimd;
  if (namespace !== undefined && (namespace === null || typeof namespace !== "object")) {
    throw new TypeError("imports.jsimd must be an object");
  }
  const instance = new WebAssembly.Instance(module, {
    ...imports,
    jsimd: { ...namespace as WebAssembly.ModuleImports | undefined, memory },
  });
  return instance.exports as T;
}

/**
 * A local worker lease over a versioned shared-memory region.
 *
 * Disposing releases only this worker ID. The backing WebAssembly.Memory remains available to
 * other workers and can be attached again.
 */
export class SharedBuffer {
  readonly memory: WebAssembly.Memory;
  readonly abiVersion: number;
  readonly dataOffset: number;
  readonly maximumPages: number;
  readonly maxWorkers: number;
  readonly workerId: number;
  readonly leaseToken: number;
  readonly #kernels: SharedBufferKernels;
  #disposed = false;

  private constructor(
    memory: WebAssembly.Memory,
    workerId: number,
    leaseToken: number,
    module: WebAssembly.Module,
  ) {
    const header = readHeader(memory);
    this.memory = memory;
    this.abiVersion = header.abiVersion;
    this.dataOffset = header.headerBytes;
    this.maximumPages = header.maximumPages;
    this.maxWorkers = header.maxWorkers;
    this.workerId = workerId;
    this.leaseToken = leaseToken;
    this.#kernels = instantiateSharedModule<SharedBufferKernels>(module, memory);
  }

  static async create(options: SharedBufferOptions = {}): Promise<SharedBuffer> {
    const initialPages = validatePageCount(options.initialPages ?? 1, "initialPages");
    const maximumPages = validatePageCount(options.maximumPages ?? initialPages, "maximumPages");
    if (maximumPages < initialPages) {
      throw new RangeError("maximumPages must be at least initialPages");
    }
    const maxWorkers = validateMaxWorkers(options.maxWorkers ?? 8);
    const headerBytes = alignTo(
      FIXED_HEADER_BYTES + maxWorkers * WORKER_SLOT_BYTES,
      SHARED_BUFFER_CACHE_LINE_BYTES,
    );
    if (headerBytes >= initialPages * 65_536) {
      throw new RangeError("initialPages must leave room after the shared header");
    }

    const memory = new WebAssembly.Memory({
      initial: initialPages,
      maximum: maximumPages,
      shared: true,
    });
    const header = new Int32Array(memory.buffer, 0, HEADER_WORDS);
    Atomics.store(header, ABI_VERSION_INDEX, SHARED_BUFFER_ABI_VERSION);
    Atomics.store(header, HEADER_BYTES_INDEX, headerBytes);
    Atomics.store(header, MAXIMUM_PAGES_INDEX, maximumPages);
    Atomics.store(header, MAX_WORKERS_INDEX, maxWorkers);
    Atomics.store(header, ACTIVE_WORKERS_INDEX, 0);
    Atomics.store(header, READY_INDEX, 1);
    Atomics.store(header, MAGIC_INDEX, MAGIC);
    return await SharedBuffer.attach(memory);
  }

  static async attach(memory: WebAssembly.Memory): Promise<SharedBuffer> {
    const header = readHeader(memory);
    const module = await loadKernelsModule();
    const workerStates = workerStateView(memory, header.maxWorkers);
    for (let workerId = 0; workerId < header.maxWorkers; workerId++) {
      const index = workerId * (WORKER_SLOT_BYTES / Int32Array.BYTES_PER_ELEMENT);
      if (Atomics.load(workerStates, index + WORKER_LEASE_INDEX) !== 0) continue;
      const generation = nextWorkerGeneration(
        Atomics.add(workerStates, index + WORKER_GENERATION_INDEX, 1),
      );
      if (generation === 1) {
        Atomics.store(workerStates, index + WORKER_GENERATION_INDEX, 1);
      }
      const leaseToken = encodeLeaseToken(workerId, generation);
      if (
        Atomics.compareExchange(workerStates, index + WORKER_LEASE_INDEX, 0, leaseToken) !== 0
      ) continue;
      Atomics.add(new Int32Array(memory.buffer, 0, HEADER_WORDS), ACTIVE_WORKERS_INDEX, 1);
      try {
        return new SharedBuffer(memory, workerId, leaseToken, module);
      } catch (error) {
        Atomics.sub(new Int32Array(memory.buffer, 0, HEADER_WORDS), ACTIVE_WORKERS_INDEX, 1);
        Atomics.compareExchange(workerStates, index + WORKER_LEASE_INDEX, leaseToken, 0);
        throw error;
      }
    }
    throw new RangeError("no shared worker slots are available");
  }

  get activeWorkers(): number {
    return Atomics.load(new Int32Array(this.memory.buffer, 0, HEADER_WORDS), ACTIVE_WORKERS_INDEX);
  }

  get disposed(): boolean {
    return this.#disposed || !this.isLeaseTokenActive(this.leaseToken);
  }

  get workerLease(): SharedWorkerLease {
    return { workerId: this.workerId, leaseToken: this.leaseToken };
  }

  /** Returns whether an ownership token still names its exact worker-slot generation. */
  isLeaseTokenActive(leaseToken: number): boolean {
    if (!Number.isSafeInteger(leaseToken) || leaseToken <= 0) return false;
    const workerId = (leaseToken & WORKER_ID_MASK) - 1;
    if (workerId < 0 || workerId >= this.maxWorkers) return false;
    const states = workerStateView(this.memory, this.maxWorkers);
    const index = workerId * (WORKER_SLOT_BYTES / Int32Array.BYTES_PER_ELEMENT);
    return Atomics.load(states, index + WORKER_LEASE_INDEX) === leaseToken;
  }

  /**
   * Reclaims a lease after its Worker has terminated without disposing it.
   *
   * The caller must first establish that the Worker can no longer access shared memory. Exact-token
   * CAS prevents an old termination notification from reclaiming a replacement generation.
   */
  reclaimTerminatedWorker(lease: SharedWorkerLease): boolean {
    this.#assertAlive();
    validateWorkerLease(lease, this.maxWorkers);
    if (lease.leaseToken === this.leaseToken) {
      throw new RangeError("a SharedBuffer lease cannot reclaim itself");
    }
    if (decodeWorkerId(lease.leaseToken) !== lease.workerId) {
      throw new RangeError("worker lease token does not match workerId");
    }
    const states = workerStateView(this.memory, this.maxWorkers);
    const index = lease.workerId * (WORKER_SLOT_BYTES / Int32Array.BYTES_PER_ELEMENT);
    if (
      Atomics.compareExchange(
        states,
        index + WORKER_LEASE_INDEX,
        lease.leaseToken,
        0,
      ) !== lease.leaseToken
    ) return false;
    Atomics.sub(new Int32Array(this.memory.buffer, 0, HEADER_WORDS), ACTIVE_WORKERS_INDEX, 1);
    return true;
  }

  get byteLength(): number {
    return this.memory.buffer.byteLength - this.dataOffset;
  }

  uint8Array(byteOffset = 0, length = this.byteLength - byteOffset): Uint8Array {
    this.#assertAlive();
    validateRange(byteOffset, length, this.byteLength, 1);
    return new Uint8Array(this.memory.buffer, this.dataOffset + byteOffset, length);
  }

  int32Array(byteOffset: number, length: number): Int32Array {
    this.#assertAlive();
    if ((byteOffset & 3) !== 0) throw new RangeError("Int32 byteOffset must be 4-byte aligned");
    validateRange(byteOffset, length, this.byteLength, Int32Array.BYTES_PER_ELEMENT);
    return new Int32Array(this.memory.buffer, this.dataOffset + byteOffset, length);
  }

  uint32Array(byteOffset: number, length: number): Uint32Array {
    this.#assertAlive();
    if ((byteOffset & 3) !== 0) throw new RangeError("Uint32 byteOffset must be 4-byte aligned");
    validateRange(byteOffset, length, this.byteLength, Uint32Array.BYTES_PER_ELEMENT);
    return new Uint32Array(this.memory.buffer, this.dataOffset + byteOffset, length);
  }

  /** Bulk owner-only fill. Concurrent readers require an external lock, barrier, or snapshot. */
  fillUint32(byteOffset: number, length: number, value: number): this {
    this.#assertAlive();
    validateUint32(value, "value");
    if ((byteOffset & 3) !== 0) throw new RangeError("Uint32 byteOffset must be 4-byte aligned");
    validateRange(byteOffset, length, this.byteLength, Uint32Array.BYTES_PER_ELEMENT);
    this.#kernels.fill_u32(this.dataOffset + byteOffset, length, value);
    return this;
  }

  /** SIMD copy for non-overlapping ranges inside this shared payload. */
  copyBytesNonOverlapping(
    destinationByteOffset: number,
    sourceByteOffset: number,
    length: number,
  ): this {
    this.#assertAlive();
    validateRange(destinationByteOffset, length, this.byteLength, 1);
    validateRange(sourceByteOffset, length, this.byteLength, 1);
    if (
      length !== 0 && destinationByteOffset < sourceByteOffset + length &&
      sourceByteOffset < destinationByteOffset + length
    ) {
      throw new RangeError("shared-memory copy ranges must not overlap");
    }
    this.#kernels.copy_bytes(
      this.dataOffset + destinationByteOffset,
      this.dataOffset + sourceByteOffset,
      length,
    );
    return this;
  }

  /** Internal bulk primitive for barrier-delimited shared bitmap reduction. */
  reduceUint32ShardsOr(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void {
    this.#reduceUint32Shards(
      this.#kernels.reduce_shards_or,
      destinationByteOffset,
      sourceByteOffset,
      shardCount,
      shardStride,
      paddedWords,
    );
  }

  /** Internal bulk primitive for barrier-delimited shared bitmap reduction. */
  reduceUint32ShardsAnd(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void {
    this.#reduceUint32Shards(
      this.#kernels.reduce_shards_and,
      destinationByteOffset,
      sourceByteOffset,
      shardCount,
      shardStride,
      paddedWords,
    );
  }

  /** Internal bulk primitive for barrier-delimited wrapping u32 reduction. */
  reduceUint32ShardsSum(
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void {
    this.#reduceUint32Shards(
      this.#kernels.reduce_shards_sum_u32,
      destinationByteOffset,
      sourceByteOffset,
      shardCount,
      shardStride,
      paddedWords,
    );
  }

  grow(additionalPages: number): number {
    this.#assertAlive();
    const pages = validateNonNegativeInteger(additionalPages, "additionalPages");
    const currentPages = this.memory.buffer.byteLength / 65_536;
    if (currentPages + pages > this.maximumPages) {
      throw new RangeError("shared memory growth exceeds maximumPages");
    }
    return this.memory.grow(pages);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const header = readHeader(this.memory);
    const states = workerStateView(this.memory, header.maxWorkers);
    const index = this.workerId * (WORKER_SLOT_BYTES / Int32Array.BYTES_PER_ELEMENT);
    if (
      Atomics.compareExchange(
        states,
        index + WORKER_LEASE_INDEX,
        this.leaseToken,
        0,
      ) !== this.leaseToken
    ) return;
    Atomics.sub(new Int32Array(this.memory.buffer, 0, HEADER_WORDS), ACTIVE_WORKERS_INDEX, 1);
  }

  #assertAlive(): void {
    if (this.disposed) throw new Error("SharedBuffer lease has been disposed or reclaimed");
  }

  #reduceUint32Shards(
    kernel: SharedBufferKernels["reduce_shards_or"],
    destinationByteOffset: number,
    sourceByteOffset: number,
    shardCount: number,
    shardStride: number,
    paddedWords: number,
  ): void {
    this.#assertAlive();
    validateNonNegativeInteger(destinationByteOffset, "destinationByteOffset");
    validateNonNegativeInteger(sourceByteOffset, "sourceByteOffset");
    validateNonNegativeInteger(shardCount, "shardCount");
    validateNonNegativeInteger(shardStride, "shardStride");
    validateNonNegativeInteger(paddedWords, "paddedWords");
    if (shardCount < 1) throw new RangeError("shardCount must be positive");
    if ((destinationByteOffset & 15) !== 0 || (sourceByteOffset & 15) !== 0) {
      throw new RangeError("bitmap offsets must be 16-byte aligned");
    }
    if ((shardStride & 15) !== 0 || (paddedWords & 3) !== 0) {
      throw new RangeError("bitmap shard layout must be SIMD-aligned");
    }
    const wordBytes = paddedWords * Uint32Array.BYTES_PER_ELEMENT;
    const sourceBytes = (shardCount - 1) * shardStride + wordBytes;
    validateRange(destinationByteOffset, wordBytes, this.byteLength, 1);
    validateRange(sourceByteOffset, sourceBytes, this.byteLength, 1);
    if (
      wordBytes !== 0 && destinationByteOffset < sourceByteOffset + sourceBytes &&
      sourceByteOffset < destinationByteOffset + wordBytes
    ) {
      throw new RangeError("bitmap reduction output must not overlap its shards");
    }
    kernel(
      this.dataOffset + destinationByteOffset,
      this.dataOffset + sourceByteOffset,
      shardCount,
      shardStride,
      paddedWords,
    );
  }
}

interface Header {
  readonly abiVersion: number;
  readonly headerBytes: number;
  readonly maximumPages: number;
  readonly maxWorkers: number;
}

function readHeader(memory: WebAssembly.Memory): Header {
  validateSharedMemory(memory);
  if (memory.buffer.byteLength < FIXED_HEADER_BYTES) {
    throw new RangeError("shared memory is too small for a jsimd header");
  }
  const header = new Int32Array(memory.buffer, 0, HEADER_WORDS);
  if (Atomics.load(header, MAGIC_INDEX) !== MAGIC || Atomics.load(header, READY_INDEX) !== 1) {
    throw new RangeError("shared memory does not contain a ready jsimd header");
  }
  const abiVersion = Atomics.load(header, ABI_VERSION_INDEX);
  if (abiVersion !== SHARED_BUFFER_ABI_VERSION) {
    throw new RangeError(`unsupported shared-memory ABI version: ${abiVersion}`);
  }
  const headerBytes = Atomics.load(header, HEADER_BYTES_INDEX);
  const maximumPages = Atomics.load(header, MAXIMUM_PAGES_INDEX);
  const maxWorkers = Atomics.load(header, MAX_WORKERS_INDEX);
  validatePageCount(maximumPages, "header maximumPages");
  validateMaxWorkers(maxWorkers);
  const expectedHeaderBytes = alignTo(
    FIXED_HEADER_BYTES + maxWorkers * WORKER_SLOT_BYTES,
    SHARED_BUFFER_CACHE_LINE_BYTES,
  );
  if (headerBytes !== expectedHeaderBytes || headerBytes >= memory.buffer.byteLength) {
    throw new RangeError("invalid shared-memory header size");
  }
  return { abiVersion, headerBytes, maximumPages, maxWorkers };
}

function workerStateView(memory: WebAssembly.Memory, maxWorkers: number): Int32Array {
  return new Int32Array(
    memory.buffer,
    FIXED_HEADER_BYTES,
    maxWorkers * (WORKER_SLOT_BYTES / Int32Array.BYTES_PER_ELEMENT),
  );
}

function validateSharedMemory(memory: WebAssembly.Memory): void {
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new TypeError("memory must be a WebAssembly.Memory");
  }
  if (!(memory.buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("memory must use a SharedArrayBuffer");
  }
}

function validateRange(
  byteOffset: number,
  length: number,
  availableBytes: number,
  elementBytes: number,
): void {
  validateNonNegativeInteger(byteOffset, "byteOffset");
  validateNonNegativeInteger(length, "length");
  const byteLength = length * elementBytes;
  if (!Number.isSafeInteger(byteLength) || byteOffset + byteLength > availableBytes) {
    throw new RangeError("shared-memory view is out of bounds");
  }
}

function validatePageCount(value: number, name: string): number {
  const result = validateNonNegativeInteger(value, name);
  if (result < 1 || result > MAXIMUM_WASM_PAGES) {
    throw new RangeError(`${name} must be between 1 and ${MAXIMUM_WASM_PAGES}`);
  }
  return result;
}

function validateMaxWorkers(value: number): number {
  const result = validateNonNegativeInteger(value, "maxWorkers");
  if (result < 1) throw new RangeError("maxWorkers must be positive");
  if (result > WORKER_ID_MASK) {
    throw new RangeError(`maxWorkers must be at most ${WORKER_ID_MASK}`);
  }
  return result;
}

function nextWorkerGeneration(previous: number): number {
  const generation = previous + 1;
  return generation > MAX_WORKER_GENERATION || generation < 1 ? 1 : generation;
}

function encodeLeaseToken(workerId: number, generation: number): number {
  return generation * (1 << WORKER_ID_BITS) + workerId + 1;
}

function decodeWorkerId(leaseToken: number): number {
  return (leaseToken & WORKER_ID_MASK) - 1;
}

function validateWorkerLease(lease: SharedWorkerLease, maxWorkers: number): void {
  if (lease === null || typeof lease !== "object") throw new TypeError("lease must be an object");
  const workerId = validateNonNegativeInteger(lease.workerId, "lease.workerId");
  if (workerId >= maxWorkers) throw new RangeError("lease.workerId is out of range");
  if (!Number.isSafeInteger(lease.leaseToken) || lease.leaseToken <= 0) {
    throw new RangeError("lease.leaseToken must be a positive integer");
  }
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateUint32(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

let kernelsModulePromise: Promise<WebAssembly.Module> | undefined;

function loadKernelsModule(): Promise<WebAssembly.Module> {
  return kernelsModulePromise ??= compileWasmModule(new URL("./kernels.wasm", import.meta.url));
}

async function compileWasmModule(url: URL): Promise<WebAssembly.Module> {
  interface NodeProcess {
    getBuiltinModule?(name: string): {
      readFileSync(path: URL): Uint8Array;
    };
  }
  const nodeProcess = (globalThis as typeof globalThis & { process?: NodeProcess }).process;
  const fileSystem = nodeProcess?.getBuiltinModule?.("node:fs");
  if (url.protocol === "file:" && fileSystem !== undefined) {
    return new WebAssembly.Module(fileSystem.readFileSync(url));
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load shared Wasm module: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("application/wasm")) {
    return await WebAssembly.compileStreaming(response);
  }
  return await WebAssembly.compile(await response.arrayBuffer());
}

export {
  SHARED_BLOCK_SIZES,
  type SharedBlock,
  SharedBlockPool,
  type SharedBlockPoolOptions,
  type SharedBlockSize,
} from "./block-pool.ts";

export {
  SHARED_SYNC_BYTE_LENGTH,
  SharedBarrier,
  SharedMutex,
  type SharedSyncBuffer,
  SharedWaitGroup,
} from "./sync.ts";

export {
  type SharedRingBufferSource,
  SPSC_RING_CACHE_LINE_BYTES,
  type SpscConsumerU32,
  type SpscProducerU32,
  SpscRingBufferU32,
} from "./spsc-ring.ts";

export { MPMC_RING_CACHE_LINE_BYTES, MpmcRingBufferU32 } from "./mpmc-ring.ts";

export { type SpscConsumerU64, type SpscProducerU64, SpscRingBufferU64 } from "./spsc-ring-u64.ts";

export { MpmcRingBufferU64 } from "./mpmc-ring-u64.ts";

export {
  ATOMIC_DENSE_BITMAP_CACHE_LINE_BYTES,
  AtomicDenseBitmap,
  type AtomicDenseBitmapBuffer,
} from "./atomic-dense-bitmap.ts";

export {
  ShardedBitmap,
  type ShardedBitmapBuffer,
  type ShardedBitmapOptions,
  type ShardedBitmapReduction,
  type ShardedBitmapShard,
} from "./sharded-bitmap.ts";

export {
  StripedCounter,
  type StripedCounterStripe,
  StripedHistogram,
  type StripedHistogramBuffer,
  type StripedHistogramOptions,
  type StripedHistogramStripe,
} from "./striped-accumulator.ts";

export {
  VERSIONED_BUFFER_CACHE_LINE_BYTES,
  VersionedBuffer,
  type VersionedBufferBacking,
  type VersionedBufferSnapshot,
  type VersionedBufferWriter,
} from "./versioned-buffer.ts";

export {
  WORK_STEALING_DEQUE_CACHE_LINE_BYTES,
  type WorkStealingDequeOwnerU32,
  WorkStealingDequeU32,
} from "./work-stealing-deque.ts";

export {
  SHARED_SLOT_MAP_CACHE_LINE_BYTES,
  type SharedSlot,
  SharedSlotMap,
  type SharedSlotMapBuffer,
  type SharedSlotMapOptions,
  type SharedSlotView,
} from "./slot-map.ts";
