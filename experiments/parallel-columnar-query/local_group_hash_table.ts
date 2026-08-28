import type { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import type { QueryKernels } from "./kernel.ts";
import type { AggregateState } from "./aggregate_state.ts";

const CACHE_LINE_BYTES = 64;
const HEADER_WORDS = CACHE_LINE_BYTES / 4;
const MAGIC = 0x4c47_5531;
const ABI_VERSION = 1;
const EMPTY = 0x80;
const MIN_CAPACITY = 16;
const MAX_CAPACITY = 0x1000_0000;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const CAPACITY_INDEX = 2;
const SIZE_INDEX = 3;
const MAX_SIZE_INDEX = 4;
const CONTROLS_OFFSET_INDEX = 5;
const KEYS_OFFSET_INDEX = 6;
const COUNTS_OFFSET_INDEX = 7;
const NULL_COUNTS_OFFSET_INDEX = 8;
const SUMS_OFFSET_INDEX = 9;
const MINIMUMS_OFFSET_INDEX = 10;
const MAXIMUMS_OFFSET_INDEX = 11;
const BYTE_LENGTH_INDEX = 12;

interface Layout {
  readonly capacity: number;
  readonly maxSize: number;
  readonly controls: number;
  readonly keys: number;
  readonly counts: number;
  readonly nullCounts: number;
  readonly sums: number;
  readonly minimums: number;
  readonly maximums: number;
  readonly byteLength: number;
}

export interface LocalGroupEntryU32 extends AggregateState {
  readonly key: number;
}

/** Worker-owned SwissTable for grouping u32 keys into nullable i32 aggregate states. */
export class LocalGroupHashTableU32 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly capacity: number;
  readonly maxSize: number;
  readonly #buffer: SharedBuffer;
  readonly #header: Int32Array;
  readonly #controls: Uint8Array;
  readonly #keys: Uint32Array;
  readonly #counts: Uint32Array;
  readonly #nullCounts: Uint32Array;
  readonly #sums: BigInt64Array;
  readonly #minimums: Int32Array;
  readonly #maximums: Int32Array;
  readonly #controlsPointer: number;
  readonly #keysPointer: number;
  readonly #countsPointer: number;
  readonly #nullCountsPointer: number;
  readonly #sumsPointer: number;
  readonly #minimumsPointer: number;
  readonly #maximumsPointer: number;

  private constructor(buffer: SharedBuffer, byteOffset: number, layout: Layout) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.capacity = layout.capacity;
    this.maxSize = layout.maxSize;
    this.#header = buffer.int32Array(byteOffset, HEADER_WORDS);
    this.#controls = buffer.uint8Array(byteOffset + layout.controls, layout.capacity);
    this.#keys = buffer.uint32Array(byteOffset + layout.keys, layout.capacity);
    this.#counts = buffer.uint32Array(byteOffset + layout.counts, layout.capacity);
    this.#nullCounts = buffer.uint32Array(byteOffset + layout.nullCounts, layout.capacity);
    this.#sums = new BigInt64Array(
      buffer.memory.buffer,
      buffer.dataOffset + byteOffset + layout.sums,
      layout.capacity,
    );
    this.#minimums = buffer.int32Array(byteOffset + layout.minimums, layout.capacity);
    this.#maximums = buffer.int32Array(byteOffset + layout.maximums, layout.capacity);
    this.#controlsPointer = buffer.dataOffset + byteOffset + layout.controls;
    this.#keysPointer = buffer.dataOffset + byteOffset + layout.keys;
    this.#countsPointer = buffer.dataOffset + byteOffset + layout.counts;
    this.#nullCountsPointer = buffer.dataOffset + byteOffset + layout.nullCounts;
    this.#sumsPointer = buffer.dataOffset + byteOffset + layout.sums;
    this.#minimumsPointer = buffer.dataOffset + byteOffset + layout.minimums;
    this.#maximumsPointer = buffer.dataOffset + byteOffset + layout.maximums;
  }

  static byteLengthFor(capacity: number): number {
    return tableLayout(capacity).byteLength;
  }

  static initialize(
    buffer: SharedBuffer,
    byteOffset: number,
    capacity: number,
  ): LocalGroupHashTableU32 {
    validateByteOffset(byteOffset);
    const layout = tableLayout(capacity);
    buffer.uint8Array(byteOffset, layout.byteLength).fill(0);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    header[VERSION_INDEX] = ABI_VERSION;
    header[CAPACITY_INDEX] = layout.capacity;
    header[SIZE_INDEX] = 0;
    header[MAX_SIZE_INDEX] = layout.maxSize;
    header[CONTROLS_OFFSET_INDEX] = layout.controls;
    header[KEYS_OFFSET_INDEX] = layout.keys;
    header[COUNTS_OFFSET_INDEX] = layout.counts;
    header[NULL_COUNTS_OFFSET_INDEX] = layout.nullCounts;
    header[SUMS_OFFSET_INDEX] = layout.sums;
    header[MINIMUMS_OFFSET_INDEX] = layout.minimums;
    header[MAXIMUMS_OFFSET_INDEX] = layout.maximums;
    header[BYTE_LENGTH_INDEX] = layout.byteLength;
    const table = new LocalGroupHashTableU32(buffer, byteOffset, layout);
    table.#controls.fill(EMPTY);
    table.#minimums.fill(I32_MAX);
    table.#maximums.fill(I32_MIN);
    header[MAGIC_INDEX] = MAGIC;
    return table;
  }

  static attach(buffer: SharedBuffer, byteOffset: number): LocalGroupHashTableU32 {
    validateByteOffset(byteOffset);
    const header = buffer.int32Array(byteOffset, HEADER_WORDS);
    if (header[MAGIC_INDEX] !== MAGIC) {
      throw new RangeError("shared memory does not contain a LocalGroupHashTableU32");
    }
    if (header[VERSION_INDEX] !== ABI_VERSION) {
      throw new RangeError(`unsupported LocalGroupHashTableU32 ABI: ${header[VERSION_INDEX]}`);
    }
    const layout = tableLayout(header[CAPACITY_INDEX]! >>> 0);
    if (
      (header[MAX_SIZE_INDEX]! >>> 0) !== layout.maxSize ||
      (header[CONTROLS_OFFSET_INDEX]! >>> 0) !== layout.controls ||
      (header[KEYS_OFFSET_INDEX]! >>> 0) !== layout.keys ||
      (header[COUNTS_OFFSET_INDEX]! >>> 0) !== layout.counts ||
      (header[NULL_COUNTS_OFFSET_INDEX]! >>> 0) !== layout.nullCounts ||
      (header[SUMS_OFFSET_INDEX]! >>> 0) !== layout.sums ||
      (header[MINIMUMS_OFFSET_INDEX]! >>> 0) !== layout.minimums ||
      (header[MAXIMUMS_OFFSET_INDEX]! >>> 0) !== layout.maximums ||
      (header[BYTE_LENGTH_INDEX]! >>> 0) !== layout.byteLength ||
      (header[SIZE_INDEX]! >>> 0) > layout.maxSize
    ) {
      throw new RangeError("invalid LocalGroupHashTableU32 layout");
    }
    buffer.uint8Array(byteOffset, layout.byteLength);
    return new LocalGroupHashTableU32(buffer, byteOffset, layout);
  }

  get size(): number {
    this.#assertAlive();
    return this.#header[SIZE_INDEX]! >>> 0;
  }

  clear(): this {
    this.#assertAlive();
    this.#controls.fill(EMPTY);
    this.#counts.fill(0);
    this.#nullCounts.fill(0);
    this.#sums.fill(0n);
    this.#minimums.fill(I32_MAX);
    this.#maximums.fill(I32_MIN);
    this.#header[SIZE_INDEX] = 0;
    return this;
  }

  add(key: number, value: number | null, kernels: QueryKernels): this {
    this.#assertAlive();
    validateUint32(key, "key");
    if (value !== null) validateInt32(value, "value");
    const result = kernels.local_group_update_i32(
      this.#controlsPointer,
      this.#keysPointer,
      this.#countsPointer,
      this.#nullCountsPointer,
      this.#sumsPointer,
      this.#minimumsPointer,
      this.#maximumsPointer,
      this.#buffer.dataOffset + this.byteOffset + SIZE_INDEX * 4,
      this.capacity,
      this.maxSize,
      key,
      value ?? 0,
      value === null ? 0 : 1,
    );
    if (result < 0) throw new RangeError("LocalGroupHashTableU32 capacity was exceeded");
    return this;
  }

  /** Bulk build over resident columns. Capacity failure leaves partial state; clear before retry. */
  aggregateResident(
    keysByteOffset: number,
    valuesByteOffset: number,
    validitiesByteOffset: number | null,
    length: number,
    kernels: QueryKernels,
  ): this {
    this.#assertAlive();
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative safe integer");
    }
    this.#buffer.uint32Array(keysByteOffset, length);
    this.#buffer.int32Array(valuesByteOffset, length);
    if (validitiesByteOffset !== null) this.#buffer.uint8Array(validitiesByteOffset, length);
    const result = kernels.local_group_aggregate_i32(
      this.#buffer.dataOffset + keysByteOffset,
      this.#buffer.dataOffset + valuesByteOffset,
      validitiesByteOffset === null ? 0 : this.#buffer.dataOffset + validitiesByteOffset,
      validitiesByteOffset === null ? 0 : 1,
      length,
      this.#controlsPointer,
      this.#keysPointer,
      this.#countsPointer,
      this.#nullCountsPointer,
      this.#sumsPointer,
      this.#minimumsPointer,
      this.#maximumsPointer,
      this.#buffer.dataOffset + this.byteOffset + SIZE_INDEX * 4,
      this.capacity,
      this.maxSize,
    );
    if (result < 0) {
      throw new RangeError("LocalGroupHashTableU32 capacity was exceeded during aggregation");
    }
    return this;
  }

  /** SIMD range filter followed by sparse grouping over resident columns. */
  aggregateResidentBetween(
    filterByteOffset: number,
    keysByteOffset: number,
    valuesByteOffset: number,
    validitiesByteOffset: number | null,
    length: number,
    minimum: number,
    maximum: number,
    kernels: QueryKernels,
  ): this {
    this.#assertAlive();
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("length must be a non-negative safe integer");
    }
    validateInt32(minimum, "minimum");
    validateInt32(maximum, "maximum");
    this.#buffer.int32Array(filterByteOffset, length);
    this.#buffer.uint32Array(keysByteOffset, length);
    this.#buffer.int32Array(valuesByteOffset, length);
    if (validitiesByteOffset !== null) this.#buffer.uint8Array(validitiesByteOffset, length);
    const result = kernels.local_group_aggregate_between_i32_u32(
      this.#buffer.dataOffset + filterByteOffset,
      this.#buffer.dataOffset + keysByteOffset,
      this.#buffer.dataOffset + valuesByteOffset,
      validitiesByteOffset === null ? 0 : this.#buffer.dataOffset + validitiesByteOffset,
      validitiesByteOffset === null ? 0 : 1,
      length,
      minimum,
      maximum,
      this.#controlsPointer,
      this.#keysPointer,
      this.#countsPointer,
      this.#nullCountsPointer,
      this.#sumsPointer,
      this.#minimumsPointer,
      this.#maximumsPointer,
      this.#buffer.dataOffset + this.byteOffset + SIZE_INDEX * 4,
      this.capacity,
      this.maxSize,
    );
    if (result < 0) {
      throw new RangeError("LocalGroupHashTableU32 capacity was exceeded during aggregation");
    }
    return this;
  }

  get(key: number, kernels: QueryKernels): AggregateState | undefined {
    this.#assertAlive();
    validateUint32(key, "key");
    const slot = kernels.local_group_find(
      this.#controlsPointer,
      this.#keysPointer,
      this.capacity,
      key,
    );
    return slot < 0 ? undefined : this.#stateAtSlot(slot);
  }

  entries(): LocalGroupEntryU32[] {
    this.#assertAlive();
    const output: LocalGroupEntryU32[] = [];
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.#controls[slot]! >= EMPTY) continue;
      output.push({ key: this.#keys[slot]!, ...this.#stateAtSlot(slot) });
    }
    return output;
  }

  /** Merges only one hash partition. One Worker must exclusively own this destination table. */
  mergePartitionFrom(
    source: LocalGroupHashTableU32,
    partition: number,
    partitionCount: number,
    kernels: QueryKernels,
  ): this {
    this.#assertAlive();
    source.#assertAlive();
    validatePartition(partition, partitionCount);
    if (this.#buffer.memory !== source.#buffer.memory) {
      throw new RangeError("local group tables must share the same WebAssembly memory");
    }
    if (rangesOverlap(this.byteOffset, this.byteLength, source.byteOffset, source.byteLength)) {
      throw new RangeError("local group table source and destination must not overlap");
    }
    const result = kernels.local_group_merge_partition(
      this.#controlsPointer,
      this.#keysPointer,
      this.#countsPointer,
      this.#nullCountsPointer,
      this.#sumsPointer,
      this.#minimumsPointer,
      this.#maximumsPointer,
      this.#buffer.dataOffset + this.byteOffset + SIZE_INDEX * 4,
      this.capacity,
      this.maxSize,
      source.#controlsPointer,
      source.#keysPointer,
      source.#countsPointer,
      source.#nullCountsPointer,
      source.#sumsPointer,
      source.#minimumsPointer,
      source.#maximumsPointer,
      source.capacity,
      partition,
      partitionCount - 1,
    );
    if (result < 0) {
      throw new RangeError("LocalGroupHashTableU32 partition destination capacity was exceeded");
    }
    return this;
  }

  #stateAtSlot(slot: number): AggregateState {
    const count = this.#counts[slot]!;
    return {
      count,
      nullCount: this.#nullCounts[slot]!,
      sum: this.#sums[slot]!,
      min: count === 0 ? null : this.#minimums[slot]!,
      max: count === 0 ? null : this.#maximums[slot]!,
      average: count === 0 ? null : Number(this.#sums[slot]!) / count,
    };
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

export function localGroupHashU32(key: number): number {
  validateUint32(key, "key");
  let hash = (key ^ (key >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x7feb_352d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x846c_a68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function tableLayout(capacity: number): Layout {
  if (
    !Number.isSafeInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY ||
    (capacity & (capacity - 1)) !== 0
  ) {
    throw new RangeError("capacity must be a power of two between 16 and 268435456");
  }
  const controls = CACHE_LINE_BYTES;
  const keys = alignTo(controls + capacity, 16);
  const counts = alignTo(keys + capacity * 4, 16);
  const nullCounts = alignTo(counts + capacity * 4, 16);
  const sums = alignTo(nullCounts + capacity * 4, 16);
  const minimums = alignTo(sums + capacity * 8, 16);
  const maximums = alignTo(minimums + capacity * 4, 16);
  const byteLength = alignTo(maximums + capacity * 4, CACHE_LINE_BYTES);
  if (
    ![keys, counts, nullCounts, sums, minimums, maximums, byteLength].every(Number.isSafeInteger)
  ) {
    throw new RangeError("LocalGroupHashTableU32 layout is too large");
  }
  return {
    capacity,
    maxSize: capacity - capacity / 8,
    controls,
    keys,
    counts,
    nullCounts,
    sums,
    minimums,
    maximums,
    byteLength,
  };
}

function validateByteOffset(byteOffset: number): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset % CACHE_LINE_BYTES !== 0) {
    throw new RangeError("byteOffset must be a non-negative 64-byte-aligned safe integer");
  }
}

function validatePartition(partition: number, partitionCount: number): void {
  if (
    !Number.isSafeInteger(partitionCount) || partitionCount < 2 ||
    (partitionCount & (partitionCount - 1)) !== 0
  ) {
    throw new RangeError("partitionCount must be a power of two of at least two");
  }
  if (!Number.isSafeInteger(partition) || partition < 0 || partition >= partitionCount) {
    throw new RangeError("partition is out of bounds");
  }
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function validateInt32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function rangesOverlap(
  leftOffset: number,
  leftLength: number,
  rightOffset: number,
  rightLength: number,
): boolean {
  return leftOffset < rightOffset + rightLength && rightOffset < leftOffset + leftLength;
}
