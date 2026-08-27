export const SHARED_SLOT_MAP_CACHE_LINE_BYTES = 64;

const SLOT_MAP_MAGIC = 0x534c_4f54;
const SLOT_MAP_ABI_VERSION = 1;
const HEADER_WORDS = SHARED_SLOT_MAP_CACHE_LINE_BYTES / Int32Array.BYTES_PER_ELEMENT;
const CURSOR_BYTE_OFFSET = SHARED_SLOT_MAP_CACHE_LINE_BYTES;
const STATES_BYTE_OFFSET = SHARED_SLOT_MAP_CACHE_LINE_BYTES * 2;
const ALLOCATED_BIT = 0x8000_0000;
const GENERATION_MASK = 0x7fff_ffff;
const MAX_HANDLE = 0x7fff_ffff_ffff_ffffn;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const PAYLOAD_BYTES_INDEX = 3;
const SLOT_STRIDE_INDEX = 4;
const STATES_OFFSET_INDEX = 5;
const DATA_OFFSET_INDEX = 6;
const BYTE_LENGTH_INDEX = 7;
const OUTSTANDING_INDEX = 8;
const CURSOR_INDEX = 0;

export interface SharedSlotMapOptions {
  readonly capacity: number;
  readonly payloadByteLength: number;
}

/** The shared-memory view operations required by SharedSlotMap. */
export interface SharedSlotMapBuffer {
  readonly disposed: boolean;
  readonly byteLength: number;
  int32Array(byteOffset: number, length: number): Int32Array;
  uint32Array(byteOffset: number, length: number): Uint32Array;
  uint8Array(byteOffset?: number, length?: number): Uint8Array;
}

/** A generation-checked non-owning view. Its lifetime must remain externally synchronized. */
export interface SharedSlotView {
  readonly handle: bigint;
  readonly index: number;
  readonly generation: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  uint8Array(byteOffset?: number, length?: number): Uint8Array;
  uint32Array(byteOffset?: number, length?: number): Uint32Array;
}

/** An owning slot lease. Dispose it with `using` to return the slot and advance its generation. */
export interface SharedSlot extends SharedSlotView, Disposable {
  readonly disposed: boolean;
}

/** A fixed-capacity shared slot allocator with generation-tagged 64-bit handles. */
export class SharedSlotMap {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dataByteOffset: number;
  readonly capacity: number;
  readonly payloadByteLength: number;
  readonly slotStride: number;
  readonly #buffer: SharedSlotMapBuffer;
  readonly #header: Int32Array;
  readonly #cursor: Int32Array;
  readonly #states: Int32Array;

  private constructor(
    buffer: SharedSlotMapBuffer,
    byteOffset: number,
    capacity: number,
    payloadByteLength: number,
    slotStride: number,
    dataOffset: number,
    byteLength: number,
    header: Int32Array,
  ) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.dataByteOffset = byteOffset + dataOffset;
    this.capacity = capacity;
    this.payloadByteLength = payloadByteLength;
    this.slotStride = slotStride;
    this.#header = header;
    this.#cursor = buffer.int32Array(byteOffset + CURSOR_BYTE_OFFSET, HEADER_WORDS);
    this.#states = buffer.int32Array(byteOffset + STATES_BYTE_OFFSET, capacity);
  }

  static byteLengthFor(options: SharedSlotMapOptions): number {
    const layout = validateOptions(options);
    return layout.byteLength;
  }

  /** Initializes the map before its SharedBuffer is published to Workers. */
  static initialize(
    buffer: SharedSlotMapBuffer,
    byteOffset: number,
    options: SharedSlotMapOptions,
  ): SharedSlotMap {
    validateByteOffset(byteOffset);
    const layout = validateOptions(options);
    buffer.uint32Array(byteOffset, layout.byteLength / Uint32Array.BYTES_PER_ELEMENT).fill(0);
    const states = buffer.int32Array(byteOffset + STATES_BYTE_OFFSET, layout.capacity);
    states.fill(1);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    Atomics.store(header, VERSION_INDEX, SLOT_MAP_ABI_VERSION);
    Atomics.store(header, CAPACITY_INDEX, layout.capacity);
    Atomics.store(header, PAYLOAD_BYTES_INDEX, layout.payloadByteLength);
    Atomics.store(header, SLOT_STRIDE_INDEX, layout.slotStride);
    Atomics.store(header, STATES_OFFSET_INDEX, STATES_BYTE_OFFSET);
    Atomics.store(header, DATA_OFFSET_INDEX, layout.dataOffset);
    Atomics.store(header, BYTE_LENGTH_INDEX, layout.byteLength);
    Atomics.store(header, OUTSTANDING_INDEX, 0);
    Atomics.store(header, MAGIC_INDEX, SLOT_MAP_MAGIC);
    return new SharedSlotMap(
      buffer,
      byteOffset,
      layout.capacity,
      layout.payloadByteLength,
      layout.slotStride,
      layout.dataOffset,
      layout.byteLength,
      header,
    );
  }

  static attach(buffer: SharedSlotMapBuffer, byteOffset: number): SharedSlotMap {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (Atomics.load(header, MAGIC_INDEX) !== SLOT_MAP_MAGIC) {
      throw new RangeError("shared memory does not contain an initialized SharedSlotMap");
    }
    const version = Atomics.load(header, VERSION_INDEX);
    if (version !== SLOT_MAP_ABI_VERSION) {
      throw new RangeError(`unsupported SharedSlotMap ABI version: ${version}`);
    }
    const layout = validateOptions({
      capacity: Atomics.load(header, CAPACITY_INDEX) >>> 0,
      payloadByteLength: Atomics.load(header, PAYLOAD_BYTES_INDEX) >>> 0,
    });
    if (
      Atomics.load(header, SLOT_STRIDE_INDEX) !== layout.slotStride ||
      Atomics.load(header, STATES_OFFSET_INDEX) !== STATES_BYTE_OFFSET ||
      Atomics.load(header, DATA_OFFSET_INDEX) !== layout.dataOffset ||
      (Atomics.load(header, BYTE_LENGTH_INDEX) >>> 0) !== layout.byteLength
    ) {
      throw new RangeError("invalid SharedSlotMap layout");
    }
    buffer.uint32Array(byteOffset, layout.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    const outstanding = Atomics.load(header, OUTSTANDING_INDEX);
    if (outstanding < 0 || outstanding > layout.capacity) {
      throw new RangeError("invalid SharedSlotMap outstanding count");
    }
    return new SharedSlotMap(
      buffer,
      byteOffset,
      layout.capacity,
      layout.payloadByteLength,
      layout.slotStride,
      layout.dataOffset,
      layout.byteLength,
      header,
    );
  }

  get outstandingSlots(): number {
    this.#assertAlive();
    return Atomics.load(this.#header, OUTSTANDING_INDEX);
  }

  allocate(): SharedSlot {
    const slot = this.tryAllocate();
    if (slot === undefined) throw new RangeError("SharedSlotMap is exhausted");
    return slot;
  }

  tryAllocate(): SharedSlot | undefined {
    this.#assertAlive();
    const start = Atomics.add(this.#cursor, CURSOR_INDEX, 1) >>> 0;
    for (let distance = 0; distance < this.capacity; distance++) {
      const index = (start + distance) % this.capacity;
      const state = Atomics.load(this.#states, index) >>> 0;
      if ((state & ALLOCATED_BIT) !== 0) continue;
      const generation = state & GENERATION_MASK;
      if (generation === 0) throw new Error("SharedSlotMap contains an invalid zero generation");
      const allocatedState = state | ALLOCATED_BIT;
      if (
        (Atomics.compareExchange(this.#states, index, state, allocatedState) >>> 0) !== state
      ) {
        distance--;
        continue;
      }
      Atomics.add(this.#header, OUTSTANDING_INDEX, 1);
      const handle = makeHandle(index, generation);
      const view = this.#createView(handle, index, generation);
      return new SharedSlotLease(view, () => this.release(handle));
    }
    return undefined;
  }

  has(handle: bigint): boolean {
    this.#assertAlive();
    const parsed = parseHandle(handle, this.capacity);
    if (parsed === undefined) return false;
    return (Atomics.load(this.#states, parsed.index) >>> 0) ===
      (ALLOCATED_BIT | parsed.generation) >>> 0;
  }

  get(handle: bigint): SharedSlotView | undefined {
    if (!this.has(handle)) return undefined;
    const parsed = parseHandle(handle, this.capacity)!;
    return this.#createView(handle, parsed.index, parsed.generation);
  }

  release(handle: bigint): boolean {
    this.#assertAlive();
    const parsed = parseHandle(handle, this.capacity);
    if (parsed === undefined) return false;
    const allocatedState = (ALLOCATED_BIT | parsed.generation) >>> 0;
    const nextGeneration = parsed.generation === GENERATION_MASK ? 1 : parsed.generation + 1;
    if (
      (Atomics.compareExchange(
        this.#states,
        parsed.index,
        allocatedState,
        nextGeneration,
      ) >>> 0) !== allocatedState
    ) {
      return false;
    }
    Atomics.sub(this.#header, OUTSTANDING_INDEX, 1);
    return true;
  }

  #createView(handle: bigint, index: number, generation: number): SharedSlotViewImpl {
    return new SharedSlotViewImpl(
      this.#buffer,
      handle,
      index,
      generation,
      this.dataByteOffset + index * this.slotStride,
      this.payloadByteLength,
      () => {
        if (!this.has(handle)) throw new Error("SharedSlot handle is stale or has been released");
      },
    );
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

class SharedSlotViewImpl implements SharedSlotView {
  readonly handle: bigint;
  readonly index: number;
  readonly generation: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly #buffer: SharedSlotMapBuffer;
  readonly #assertLive: () => void;

  constructor(
    buffer: SharedSlotMapBuffer,
    handle: bigint,
    index: number,
    generation: number,
    byteOffset: number,
    byteLength: number,
    assertLive: () => void,
  ) {
    this.#buffer = buffer;
    this.handle = handle;
    this.index = index;
    this.generation = generation;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
    this.#assertLive = assertLive;
  }

  uint8Array(byteOffset = 0, length = this.byteLength - byteOffset): Uint8Array {
    this.#assertLive();
    validateRange(byteOffset, length, this.byteLength, 1);
    return this.#buffer.uint8Array(this.byteOffset + byteOffset, length);
  }

  uint32Array(
    byteOffset = 0,
    length = Math.floor((this.byteLength - byteOffset) / Uint32Array.BYTES_PER_ELEMENT),
  ): Uint32Array {
    this.#assertLive();
    if ((byteOffset & 3) !== 0) throw new RangeError("Uint32 byteOffset must be 4-byte aligned");
    validateRange(byteOffset, length, this.byteLength, Uint32Array.BYTES_PER_ELEMENT);
    return this.#buffer.uint32Array(this.byteOffset + byteOffset, length);
  }
}

class SharedSlotLease implements SharedSlot {
  readonly #view: SharedSlotViewImpl;
  readonly #release: () => boolean;
  #disposed = false;

  constructor(view: SharedSlotViewImpl, release: () => boolean) {
    this.#view = view;
    this.#release = release;
  }

  get handle(): bigint {
    return this.#view.handle;
  }

  get index(): number {
    return this.#view.index;
  }

  get generation(): number {
    return this.#view.generation;
  }

  get byteOffset(): number {
    return this.#view.byteOffset;
  }

  get byteLength(): number {
    return this.#view.byteLength;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  uint8Array(byteOffset?: number, length?: number): Uint8Array {
    this.#assertAlive();
    return this.#view.uint8Array(byteOffset, length);
  }

  uint32Array(byteOffset?: number, length?: number): Uint32Array {
    this.#assertAlive();
    return this.#view.uint32Array(byteOffset, length);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SharedSlot lease has been disposed");
  }
}

interface SlotMapLayout {
  readonly capacity: number;
  readonly payloadByteLength: number;
  readonly slotStride: number;
  readonly dataOffset: number;
  readonly byteLength: number;
}

function validateOptions(options: SharedSlotMapOptions): SlotMapLayout {
  if (options === null || typeof options !== "object") {
    throw new TypeError("SharedSlotMap options must be an object");
  }
  const capacity = validatePositiveInteger(options.capacity, "capacity");
  if (capacity > GENERATION_MASK) {
    throw new RangeError(`capacity must not exceed ${GENERATION_MASK}`);
  }
  const payloadByteLength = validatePositiveInteger(
    options.payloadByteLength,
    "payloadByteLength",
  );
  const slotStride = alignTo(payloadByteLength, 16);
  const statesEnd = STATES_BYTE_OFFSET + capacity * Int32Array.BYTES_PER_ELEMENT;
  const dataOffset = alignTo(statesEnd, SHARED_SLOT_MAP_CACHE_LINE_BYTES);
  const byteLength = alignTo(
    dataOffset + capacity * slotStride,
    SHARED_SLOT_MAP_CACHE_LINE_BYTES,
  );
  if (!Number.isSafeInteger(byteLength) || byteLength > 0xffff_ffff) {
    throw new RangeError("SharedSlotMap layout exceeds the 32-bit shared-memory ABI");
  }
  return { capacity, payloadByteLength, slotStride, dataOffset, byteLength };
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (byteOffset % SHARED_SLOT_MAP_CACHE_LINE_BYTES !== 0) {
    throw new RangeError(`byteOffset must be ${SHARED_SLOT_MAP_CACHE_LINE_BYTES}-byte aligned`);
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateRange(
  byteOffset: number,
  length: number,
  availableBytes: number,
  elementBytes: number,
): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new RangeError("byteOffset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("length must be a non-negative safe integer");
  }
  const byteLength = length * elementBytes;
  if (!Number.isSafeInteger(byteLength) || byteOffset + byteLength > availableBytes) {
    throw new RangeError("SharedSlot view is out of bounds");
  }
}

function makeHandle(index: number, generation: number): bigint {
  return (BigInt(generation) << 32n) | BigInt(index);
}

function parseHandle(
  handle: bigint,
  capacity: number,
): { readonly index: number; readonly generation: number } | undefined {
  if (typeof handle !== "bigint" || handle < 0n || handle > MAX_HANDLE) return undefined;
  const index = Number(handle & 0xffff_ffffn);
  const generation = Number(handle >> 32n);
  if (index >= capacity || generation === 0 || generation > GENERATION_MASK) return undefined;
  return { index, generation };
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
