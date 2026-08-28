import type { SharedBuffer } from "@mizchi/jsimd-shared";
import type { QueryKernels } from "./kernel.ts";

const CACHE_LINE_BYTES = 64;
const HEADER_BYTES = 128;
const HEADER_WORDS = HEADER_BYTES / 4;
const MAGIC = 0x484a_5531;
const ABI_VERSION = 1;
const EMPTY = 0x80;
const EMPTY_NODE = 0xffff_ffff;
const MIN_CAPACITY = 16;
const MAX_CAPACITY = 0x1000_0000;

const MAGIC_INDEX = 0;
const VERSION_INDEX = 1;
const PARTITION_COUNT_INDEX = 2;
const CAPACITY_INDEX = 3;
const MAX_SIZE_INDEX = 4;
const MAX_BUILD_ROWS_INDEX = 5;
const BUILD_ROWS_INDEX = 6;
const DISTINCT_KEYS_INDEX = 7;
const BLOOM_BLOCKS_INDEX = 8;
const PARTITION_SIZES_OFFSET_INDEX = 9;
const CONTROLS_OFFSET_INDEX = 10;
const KEYS_OFFSET_INDEX = 11;
const HEADS_OFFSET_INDEX = 12;
const NODE_ROWS_OFFSET_INDEX = 13;
const NODE_NEXT_OFFSET_INDEX = 14;
const BLOOM_OFFSET_INDEX = 15;
const BYTE_LENGTH_INDEX = 16;

export interface PartitionedHashJoinOptions {
  readonly partitionCount: number;
  readonly capacityPerPartition: number;
  readonly maxBuildRows: number;
  readonly bloomBitsPerKey?: number;
}

export interface HashJoinCountResult {
  readonly matchCount: number;
  readonly bloomRejected: number;
}

export interface HashJoinProbeResult {
  readonly matchCount: number;
  readonly written: number;
  readonly truncated: boolean;
}

interface Layout {
  readonly partitionCount: number;
  readonly capacity: number;
  readonly maxSize: number;
  readonly maxBuildRows: number;
  readonly bloomBlocks: number;
  readonly partitionSizes: number;
  readonly controls: number;
  readonly keys: number;
  readonly heads: number;
  readonly nodeRows: number;
  readonly nodeNext: number;
  readonly bloom: number;
  readonly byteLength: number;
}

/** Experimental partition-owned hash table for u32 equi-join row-ID pairs. */
export class PartitionedHashJoinTableU32 {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly partitionCount: number;
  readonly capacityPerPartition: number;
  readonly maxSizePerPartition: number;
  readonly maxBuildRows: number;
  readonly bloomBlocksPerPartition: number;
  readonly #buffer: SharedBuffer;
  readonly #header: Uint32Array;
  readonly #partitionSizes: Uint32Array;
  readonly #controls: Uint8Array;
  readonly #heads: Uint32Array;
  readonly #partitionSizesPointer: number;
  readonly #controlsPointer: number;
  readonly #keysPointer: number;
  readonly #headsPointer: number;
  readonly #nodeRowsPointer: number;
  readonly #nodeNextPointer: number;
  readonly #bloomPointer: number;

  private constructor(buffer: SharedBuffer, byteOffset: number, layout: Layout) {
    this.#buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.partitionCount = layout.partitionCount;
    this.capacityPerPartition = layout.capacity;
    this.maxSizePerPartition = layout.maxSize;
    this.maxBuildRows = layout.maxBuildRows;
    this.bloomBlocksPerPartition = layout.bloomBlocks;
    this.#header = buffer.uint32Array(byteOffset, HEADER_WORDS);
    this.#partitionSizes = buffer.uint32Array(
      byteOffset + layout.partitionSizes,
      layout.partitionCount,
    );
    this.#controls = buffer.uint8Array(
      byteOffset + layout.controls,
      layout.partitionCount * layout.capacity,
    );
    this.#heads = buffer.uint32Array(
      byteOffset + layout.heads,
      layout.partitionCount * layout.capacity,
    );
    const base = buffer.dataOffset + byteOffset;
    this.#partitionSizesPointer = base + layout.partitionSizes;
    this.#controlsPointer = base + layout.controls;
    this.#keysPointer = base + layout.keys;
    this.#headsPointer = base + layout.heads;
    this.#nodeRowsPointer = base + layout.nodeRows;
    this.#nodeNextPointer = base + layout.nodeNext;
    this.#bloomPointer = layout.bloomBlocks === 0 ? 0 : base + layout.bloom;
  }

  static byteLengthFor(options: PartitionedHashJoinOptions): number {
    return tableLayout(options).byteLength;
  }

  static initialize(
    buffer: SharedBuffer,
    byteOffset: number,
    options: PartitionedHashJoinOptions,
  ): PartitionedHashJoinTableU32 {
    validateByteOffset(byteOffset);
    const layout = tableLayout(options);
    buffer.uint8Array(byteOffset, layout.byteLength).fill(0);
    const header = buffer.uint32Array(byteOffset, HEADER_WORDS);
    header[VERSION_INDEX] = ABI_VERSION;
    header[PARTITION_COUNT_INDEX] = layout.partitionCount;
    header[CAPACITY_INDEX] = layout.capacity;
    header[MAX_SIZE_INDEX] = layout.maxSize;
    header[MAX_BUILD_ROWS_INDEX] = layout.maxBuildRows;
    header[BLOOM_BLOCKS_INDEX] = layout.bloomBlocks;
    header[PARTITION_SIZES_OFFSET_INDEX] = layout.partitionSizes;
    header[CONTROLS_OFFSET_INDEX] = layout.controls;
    header[KEYS_OFFSET_INDEX] = layout.keys;
    header[HEADS_OFFSET_INDEX] = layout.heads;
    header[NODE_ROWS_OFFSET_INDEX] = layout.nodeRows;
    header[NODE_NEXT_OFFSET_INDEX] = layout.nodeNext;
    header[BLOOM_OFFSET_INDEX] = layout.bloom;
    header[BYTE_LENGTH_INDEX] = layout.byteLength;
    const table = new PartitionedHashJoinTableU32(buffer, byteOffset, layout);
    table.#controls.fill(EMPTY);
    table.#heads.fill(EMPTY_NODE);
    header[MAGIC_INDEX] = MAGIC;
    return table;
  }

  static attach(buffer: SharedBuffer, byteOffset: number): PartitionedHashJoinTableU32 {
    validateByteOffset(byteOffset);
    const header = buffer.uint32Array(byteOffset, HEADER_WORDS);
    if (header[MAGIC_INDEX] !== MAGIC) {
      throw new RangeError("shared memory does not contain a PartitionedHashJoinTableU32");
    }
    if (header[VERSION_INDEX] !== ABI_VERSION) {
      throw new RangeError(`unsupported PartitionedHashJoinTableU32 ABI: ${header[VERSION_INDEX]}`);
    }
    const options = {
      partitionCount: header[PARTITION_COUNT_INDEX]!,
      capacityPerPartition: header[CAPACITY_INDEX]!,
      maxBuildRows: header[MAX_BUILD_ROWS_INDEX]!,
      bloomBitsPerKey: 0,
    };
    const layout = tableLayoutFromBloomBlocks(options, header[BLOOM_BLOCKS_INDEX]!);
    if (
      header[MAX_SIZE_INDEX] !== layout.maxSize ||
      header[PARTITION_SIZES_OFFSET_INDEX] !== layout.partitionSizes ||
      header[CONTROLS_OFFSET_INDEX] !== layout.controls ||
      header[KEYS_OFFSET_INDEX] !== layout.keys || header[HEADS_OFFSET_INDEX] !== layout.heads ||
      header[NODE_ROWS_OFFSET_INDEX] !== layout.nodeRows ||
      header[NODE_NEXT_OFFSET_INDEX] !== layout.nodeNext ||
      header[BLOOM_OFFSET_INDEX] !== layout.bloom ||
      header[BYTE_LENGTH_INDEX] !== layout.byteLength ||
      header[BUILD_ROWS_INDEX]! > layout.maxBuildRows
    ) throw new RangeError("invalid PartitionedHashJoinTableU32 layout");
    buffer.uint8Array(byteOffset, layout.byteLength);
    return new PartitionedHashJoinTableU32(buffer, byteOffset, layout);
  }

  get buildRows(): number {
    this.#assertAlive();
    return this.#header[BUILD_ROWS_INDEX]!;
  }

  get distinctKeys(): number {
    this.#assertAlive();
    return this.#header[DISTINCT_KEYS_INDEX]!;
  }

  clear(): this {
    this.#assertAlive();
    this.#partitionSizes.fill(0);
    this.#controls.fill(EMPTY);
    this.#heads.fill(EMPTY_NODE);
    if (this.bloomBlocksPerPartition !== 0) {
      this.#buffer.uint8Array(
        this.#bloomPointer - this.#buffer.dataOffset,
        this.partitionCount * this.bloomBlocksPerPartition * 16,
      ).fill(0);
    }
    this.#header[BUILD_ROWS_INDEX] = 0;
    this.#header[DISTINCT_KEYS_INDEX] = 0;
    return this;
  }

  /** Replaces the build side. Capacity failure leaves partial state; clear before reuse. */
  buildResident(
    keysByteOffset: number,
    rowIdsByteOffset: number,
    length: number,
    kernels: QueryKernels,
  ): this {
    this.#assertAlive();
    validateLength(length, this.maxBuildRows, "build length");
    this.#buffer.uint32Array(keysByteOffset, length);
    this.#buffer.uint32Array(rowIdsByteOffset, length);
    this.clear();
    const result = kernels.hash_join_build_u32(
      this.#buffer.dataOffset + keysByteOffset,
      this.#buffer.dataOffset + rowIdsByteOffset,
      length,
      this.#partitionSizesPointer,
      this.#controlsPointer,
      this.#keysPointer,
      this.#headsPointer,
      this.#nodeRowsPointer,
      this.#nodeNextPointer,
      this.#bloomPointer,
      this.bloomBlocksPerPartition,
      this.#buffer.dataOffset + this.byteOffset + BUILD_ROWS_INDEX * 4,
      this.#buffer.dataOffset + this.byteOffset + DISTINCT_KEYS_INDEX * 4,
      this.partitionCount,
      this.capacityPerPartition,
      this.maxSizePerPartition,
      this.maxBuildRows,
    );
    if (result < 0) {
      throw new RangeError("PartitionedHashJoinTableU32 partition capacity was exceeded");
    }
    return this;
  }

  countMatchesResident(
    probeKeysByteOffset: number,
    length: number,
    kernels: QueryKernels,
  ): HashJoinCountResult {
    this.#assertAlive();
    validateLength(length, 0xffff_ffff, "probe length");
    this.#buffer.uint32Array(probeKeysByteOffset, length);
    const packed = kernels.hash_join_count_u32(
      this.#buffer.dataOffset + probeKeysByteOffset,
      length,
      this.#controlsPointer,
      this.#keysPointer,
      this.#headsPointer,
      this.#nodeNextPointer,
      this.#bloomPointer,
      this.bloomBlocksPerPartition,
      this.partitionCount,
      this.capacityPerPartition,
    );
    return {
      matchCount: Number(packed & 0xffff_ffffn),
      bloomRejected: Number((packed >> 32n) & 0xffff_ffffn),
    };
  }

  probeResident(
    probeKeysByteOffset: number,
    probeRowIdsByteOffset: number,
    length: number,
    outputProbeRowIdsByteOffset: number,
    outputBuildRowIdsByteOffset: number,
    outputCapacity: number,
    kernels: QueryKernels,
  ): HashJoinProbeResult {
    this.#assertAlive();
    validateLength(length, 0xffff_ffff, "probe length");
    validateLength(outputCapacity, 0xffff_ffff, "output capacity");
    this.#buffer.uint32Array(probeKeysByteOffset, length);
    this.#buffer.uint32Array(probeRowIdsByteOffset, length);
    this.#buffer.uint32Array(outputProbeRowIdsByteOffset, outputCapacity);
    this.#buffer.uint32Array(outputBuildRowIdsByteOffset, outputCapacity);
    const packed = kernels.hash_join_probe_u32(
      this.#buffer.dataOffset + probeKeysByteOffset,
      this.#buffer.dataOffset + probeRowIdsByteOffset,
      length,
      this.#buffer.dataOffset + outputProbeRowIdsByteOffset,
      this.#buffer.dataOffset + outputBuildRowIdsByteOffset,
      outputCapacity,
      this.#controlsPointer,
      this.#keysPointer,
      this.#headsPointer,
      this.#nodeRowsPointer,
      this.#nodeNextPointer,
      this.#bloomPointer,
      this.bloomBlocksPerPartition,
      this.partitionCount,
      this.capacityPerPartition,
    );
    const written = Number(packed & 0xffff_ffffn);
    const matchCount = Number((packed >> 32n) & 0xffff_ffffn);
    return { matchCount, written, truncated: written !== matchCount };
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

function tableLayout(options: PartitionedHashJoinOptions): Layout {
  validateOptions(options);
  const bloomBits = options.bloomBitsPerKey ?? 0;
  const expectedPerPartition = Math.ceil(options.maxBuildRows / options.partitionCount);
  const bloomBlocks = bloomBits === 0
    ? 0
    : Math.max(1, Math.ceil(expectedPerPartition * bloomBits / 128));
  return tableLayoutFromBloomBlocks(options, bloomBlocks);
}

function tableLayoutFromBloomBlocks(
  options: Omit<PartitionedHashJoinOptions, "bloomBitsPerKey">,
  bloomBlocks: number,
): Layout {
  validateOptions(options);
  if (!Number.isSafeInteger(bloomBlocks) || bloomBlocks < 0) {
    throw new RangeError("invalid Bloom block count");
  }
  const slots = options.partitionCount * options.capacityPerPartition;
  const partitionSizes = HEADER_BYTES;
  const controls = alignTo(partitionSizes + options.partitionCount * 4, 16);
  const keys = alignTo(controls + slots, 16);
  const heads = alignTo(keys + slots * 4, 16);
  const nodeRows = alignTo(heads + slots * 4, 16);
  const nodeNext = alignTo(nodeRows + options.maxBuildRows * 4, 16);
  const bloom = alignTo(nodeNext + options.maxBuildRows * 4, 16);
  const byteLength = alignTo(
    bloom + options.partitionCount * bloomBlocks * 16,
    CACHE_LINE_BYTES,
  );
  return {
    partitionCount: options.partitionCount,
    capacity: options.capacityPerPartition,
    maxSize: options.capacityPerPartition * 7 >>> 3,
    maxBuildRows: options.maxBuildRows,
    bloomBlocks,
    partitionSizes,
    controls,
    keys,
    heads,
    nodeRows,
    nodeNext,
    bloom,
    byteLength,
  };
}

function validateOptions(
  options: Omit<PartitionedHashJoinOptions, "bloomBitsPerKey"> & {
    readonly bloomBitsPerKey?: number;
  },
): void {
  validatePowerOfTwo(options.partitionCount, 1, 256, "partitionCount");
  validatePowerOfTwo(
    options.capacityPerPartition,
    MIN_CAPACITY,
    MAX_CAPACITY,
    "capacityPerPartition",
  );
  validateLength(options.maxBuildRows, 0x0fff_ffff, "maxBuildRows");
  const bloomBits = options.bloomBitsPerKey ?? 0;
  if (!Number.isFinite(bloomBits) || bloomBits < 0 || bloomBits > 128) {
    throw new RangeError("bloomBitsPerKey must be zero or between 1 and 128");
  }
}

function validatePowerOfTwo(value: number, minimum: number, maximum: number, name: string): void {
  if (
    !Number.isSafeInteger(value) || value < minimum || value > maximum ||
    (value & (value - 1)) !== 0
  ) throw new RangeError(`${name} must be a power of two between ${minimum} and ${maximum}`);
}

function validateLength(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a non-negative safe integer up to ${maximum}`);
  }
}

function validateByteOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value % CACHE_LINE_BYTES !== 0) {
    throw new RangeError("byteOffset must be a non-negative cache-line-aligned integer");
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
