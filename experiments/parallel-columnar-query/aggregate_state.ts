import type { SharedBuffer } from "../../packages/jsimd/src/shared-buffer/mod.ts";
import type { QueryKernels } from "./kernel.ts";

const CACHE_LINE_BYTES = 64;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export interface AggregateStateInput {
  readonly count: number;
  readonly nullCount: number;
  readonly sum: bigint;
  readonly min: number | null;
  readonly max: number | null;
}

export interface AggregateState extends AggregateStateInput {
  readonly average: number | null;
}

interface AggregateStateLayout {
  readonly counts: number;
  readonly nullCounts: number;
  readonly sums: number;
  readonly minimums: number;
  readonly maximums: number;
  readonly byteLength: number;
}

/**
 * Non-owning SoA view over worker-local aggregate state in a SharedBuffer.
 *
 * The caller owns and disposes the SharedBuffer. Merges are only valid after an external barrier;
 * they are deliberately non-atomic so the Wasm implementation can reduce four groups at a time.
 */
export class AggregateStateBlock {
  readonly groupCount: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly countsPointer: number;
  readonly nullCountsPointer: number;
  readonly sumsPointer: number;
  readonly minimumsPointer: number;
  readonly maximumsPointer: number;
  readonly #buffer: SharedBuffer;
  readonly #counts: Uint32Array;
  readonly #nullCounts: Uint32Array;
  readonly #sums: BigInt64Array;
  readonly #minimums: Int32Array;
  readonly #maximums: Int32Array;

  private constructor(buffer: SharedBuffer, byteOffset: number, groupCount: number) {
    const layout = aggregateStateLayout(groupCount);
    buffer.uint8Array(byteOffset, layout.byteLength);
    this.#buffer = buffer;
    this.groupCount = groupCount;
    this.byteOffset = byteOffset;
    this.byteLength = layout.byteLength;
    this.#counts = buffer.uint32Array(byteOffset + layout.counts, groupCount);
    this.#nullCounts = buffer.uint32Array(byteOffset + layout.nullCounts, groupCount);
    this.#sums = new BigInt64Array(
      buffer.memory.buffer,
      buffer.dataOffset + byteOffset + layout.sums,
      groupCount,
    );
    this.#minimums = buffer.int32Array(byteOffset + layout.minimums, groupCount);
    this.#maximums = buffer.int32Array(byteOffset + layout.maximums, groupCount);
    this.countsPointer = buffer.dataOffset + byteOffset + layout.counts;
    this.nullCountsPointer = buffer.dataOffset + byteOffset + layout.nullCounts;
    this.sumsPointer = buffer.dataOffset + byteOffset + layout.sums;
    this.minimumsPointer = buffer.dataOffset + byteOffset + layout.minimums;
    this.maximumsPointer = buffer.dataOffset + byteOffset + layout.maximums;
  }

  static byteLengthFor(groupCount: number): number {
    return aggregateStateLayout(groupCount).byteLength;
  }

  static attach(buffer: SharedBuffer, byteOffset: number, groupCount: number): AggregateStateBlock {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      throw new RangeError("byteOffset must be a non-negative safe integer");
    }
    if (byteOffset % CACHE_LINE_BYTES !== 0) {
      throw new RangeError("AggregateStateBlock byteOffset must be 64-byte aligned");
    }
    return new AggregateStateBlock(buffer, byteOffset, groupCount);
  }

  reset(): this {
    this.#assertAlive();
    this.#counts.fill(0);
    this.#nullCounts.fill(0);
    this.#sums.fill(0n);
    this.#minimums.fill(I32_MAX);
    this.#maximums.fill(I32_MIN);
    return this;
  }

  at(index: number): AggregateState {
    this.#assertAlive();
    this.#validateIndex(index);
    const count = this.#counts[index]!;
    return {
      count,
      nullCount: this.#nullCounts[index]!,
      sum: this.#sums[index]!,
      min: count === 0 ? null : this.#minimums[index]!,
      max: count === 0 ? null : this.#maximums[index]!,
      average: count === 0 ? null : Number(this.#sums[index]!) / count,
    };
  }

  set(index: number, state: AggregateStateInput): this {
    this.#assertAlive();
    this.#validateIndex(index);
    validateUint32(state.count, "count");
    validateUint32(state.nullCount, "nullCount");
    if (typeof state.sum !== "bigint" || state.sum < I64_MIN || state.sum > I64_MAX) {
      throw new RangeError("sum must fit in a signed 64-bit integer");
    }
    if (state.count === 0) {
      if (state.sum !== 0n || state.min !== null || state.max !== null) {
        throw new RangeError("an empty aggregate must have zero sum and null extrema");
      }
      this.#minimums[index] = I32_MAX;
      this.#maximums[index] = I32_MIN;
    } else {
      if (state.min === null || state.max === null) {
        throw new TypeError("a non-empty aggregate must have numeric extrema");
      }
      validateInt32(state.min, "min");
      validateInt32(state.max, "max");
      if (state.min > state.max) throw new RangeError("min must not exceed max");
      this.#minimums[index] = state.min;
      this.#maximums[index] = state.max;
    }
    this.#counts[index] = state.count;
    this.#nullCounts[index] = state.nullCount;
    this.#sums[index] = state.sum;
    return this;
  }

  /** Merges a disjoint source block after callers have established a synchronization barrier. */
  mergeFrom(source: AggregateStateBlock, kernels: QueryKernels): this {
    this.#assertAlive();
    source.#assertAlive();
    if (source.groupCount !== this.groupCount) {
      throw new RangeError("aggregate blocks must have the same group count");
    }
    if (source.#buffer.memory !== this.#buffer.memory) {
      throw new RangeError("aggregate blocks must share the same WebAssembly memory");
    }
    if (rangesOverlap(this.byteOffset, this.byteLength, source.byteOffset, source.byteLength)) {
      throw new RangeError("aggregate source and destination blocks must not overlap");
    }
    kernels.merge_aggregate_state_blocks(
      this.countsPointer,
      this.nullCountsPointer,
      this.sumsPointer,
      this.minimumsPointer,
      this.maximumsPointer,
      source.countsPointer,
      source.nullCountsPointer,
      source.sumsPointer,
      source.minimumsPointer,
      source.maximumsPointer,
      this.groupCount,
    );
    return this;
  }

  #validateIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.groupCount) {
      throw new RangeError("aggregate group index is out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#buffer.disposed) throw new Error("SharedBuffer lease has been disposed");
  }
}

function aggregateStateLayout(groupCount: number): AggregateStateLayout {
  if (!Number.isSafeInteger(groupCount) || groupCount <= 0) {
    throw new RangeError("groupCount must be a positive safe integer");
  }
  const counts = 0;
  const nullCounts = alignTo(counts + checkedMultiply(groupCount, 4), 16);
  const sums = alignTo(nullCounts + checkedMultiply(groupCount, 4), 16);
  const minimums = alignTo(sums + checkedMultiply(groupCount, 8), 16);
  const maximums = alignTo(minimums + checkedMultiply(groupCount, 4), 16);
  const byteLength = alignTo(maximums + checkedMultiply(groupCount, 4), CACHE_LINE_BYTES);
  if (![nullCounts, sums, minimums, maximums, byteLength].every(Number.isSafeInteger)) {
    throw new RangeError("aggregate state layout exceeds the safe integer range");
  }
  return { counts, nullCounts, sums, minimums, maximums, byteLength };
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new RangeError("aggregate state layout is too large");
  return value;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
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

function rangesOverlap(
  leftOffset: number,
  leftLength: number,
  rightOffset: number,
  rightLength: number,
): boolean {
  return leftOffset < rightOffset + rightLength && rightOffset < leftOffset + leftLength;
}
