import {
  access as wasmAccess,
  access_many as wasmAccessMany,
  build as wasmBuild,
  count_lt as wasmCountLessThan,
  memory,
  quantile as wasmQuantile,
  quantile_many as wasmQuantileMany,
  rank as wasmRank,
  rank_many as wasmRankMany,
  select as wasmSelect,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";
import {
  decodeSnapshot,
  encodeSnapshot,
  expectPayloadBytes,
  SnapshotKind,
  validateWaveletPayloads,
} from "../internal/snapshot.ts";

const LEVELS = 32;
const UINT32_LIMIT = 0x1_0000_0000;
const allocator = new LinearMemoryAllocator(memory);

type WaveletSource =
  | { readonly values: ArrayLike<number> }
  | {
    readonly length: number;
    readonly bits: Uint8Array;
    readonly ranks: Uint8Array;
    readonly zeros: Uint8Array;
  };

/** An immutable binary wavelet matrix over the complete unsigned 32-bit value domain. */
export class WaveletMatrixUint32 {
  readonly length: number;
  readonly #paddedWords: number;
  readonly #superblocks: number;
  readonly #bitsAllocation: Allocation;
  readonly #rankAllocation: Allocation;
  readonly #zeroAllocation: Allocation;
  #disposed = false;

  private constructor(source: WaveletSource) {
    const values = "values" in source ? source.values : undefined;
    const length = "values" in source ? source.values.length : source.length;
    validateLength(length);
    if (values !== undefined) validateValues(values);
    this.length = length;
    const words = Math.ceil(this.length / 32);
    this.#paddedWords = (words + 3) & ~3;
    this.#superblocks = Math.ceil(this.#paddedWords / 16);

    this.#bitsAllocation = allocator.allocate(LEVELS * this.#paddedWords * 4);
    try {
      this.#rankAllocation = allocator.allocate(LEVELS * (this.#superblocks + 1) * 4);
    } catch (error) {
      allocator.release(this.#bitsAllocation);
      throw error;
    }
    try {
      this.#zeroAllocation = allocator.allocate(LEVELS * 4);
    } catch (error) {
      allocator.release(this.#rankAllocation);
      allocator.release(this.#bitsAllocation);
      throw error;
    }

    try {
      if ("bits" in source) {
        new Uint8Array(
          memory.buffer,
          this.#bitsAllocation.pointer,
          this.#bitsAllocation.byteLength,
        ).set(source.bits);
        new Uint8Array(
          memory.buffer,
          this.#rankAllocation.pointer,
          this.#rankAllocation.byteLength,
        ).set(source.ranks);
        new Uint8Array(
          memory.buffer,
          this.#zeroAllocation.pointer,
          this.#zeroAllocation.byteLength,
        ).set(source.zeros);
      } else {
        const scratch = allocator.allocate(this.length * 8);
        try {
          new Uint32Array(memory.buffer, scratch.pointer, this.length).set(source.values);
          wasmBuild(
            scratch.pointer,
            scratch.pointer + this.length * 4,
            this.#bitsAllocation.pointer,
            this.#rankAllocation.pointer,
            this.#zeroAllocation.pointer,
            this.length,
            this.#paddedWords,
            this.#superblocks,
          );
        } finally {
          allocator.release(scratch);
        }
      }
    } catch (error) {
      allocator.release(this.#zeroAllocation);
      allocator.release(this.#rankAllocation);
      allocator.release(this.#bitsAllocation);
      throw error;
    }
  }

  static from(values: ArrayLike<number>): WaveletMatrixUint32 {
    return new WaveletMatrixUint32({ values });
  }

  static fromSnapshot(snapshot: Uint8Array): WaveletMatrixUint32 {
    const { shape, payloads } = decodeSnapshot(
      snapshot,
      SnapshotKind.WaveletMatrixUint32,
      1,
      3,
    );
    const length = shape[0]!;
    validateLength(length);
    const paddedWords = (Math.ceil(length / 32) + 3) & ~3;
    const superblocks = Math.ceil(paddedWords / 16);
    expectPayloadBytes(payloads[0]!, LEVELS * paddedWords * 4, "wavelet bits");
    expectPayloadBytes(payloads[1]!, LEVELS * (superblocks + 1) * 4, "wavelet ranks");
    expectPayloadBytes(payloads[2]!, LEVELS * 4, "wavelet zeros");
    validateWaveletPayloads(
      length,
      LEVELS,
      paddedWords,
      superblocks,
      payloads[0]!,
      payloads[1]!,
      payloads[2]!,
    );
    return new WaveletMatrixUint32({
      length,
      bits: payloads[0]!,
      ranks: payloads[1]!,
      zeros: payloads[2]!,
    });
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  serialize(): Uint8Array {
    this.#assertAlive();
    return encodeSnapshot(SnapshotKind.WaveletMatrixUint32, [this.length], [
      new Uint8Array(
        memory.buffer,
        this.#bitsAllocation.pointer,
        LEVELS * this.#paddedWords * 4,
      ),
      new Uint8Array(
        memory.buffer,
        this.#rankAllocation.pointer,
        LEVELS * (this.#superblocks + 1) * 4,
      ),
      new Uint8Array(
        memory.buffer,
        this.#zeroAllocation.pointer,
        LEVELS * 4,
      ),
    ]);
  }

  access(index: number): number {
    this.#checkIndex(index);
    return wasmAccess(...this.#queryBase(), index) >>> 0;
  }

  rank(value: number, end: number): number {
    this.#assertAlive();
    validateUint32(value, "value");
    this.#checkEnd(end);
    return wasmRank(...this.#queryBase(), value, end);
  }

  select(value: number, occurrence: number): number {
    this.#assertAlive();
    validateUint32(value, "value");
    if (!Number.isSafeInteger(occurrence)) throw new RangeError("invalid occurrence");
    if (occurrence < 0 || occurrence >= this.length) return -1;
    return wasmSelect(...this.#queryBase(), this.length, value, occurrence);
  }

  rangeFreq(left: number, right: number, min: number, max: number): number {
    this.#checkRange(left, right);
    validateBound(min, "min");
    validateBound(max, "max");
    if (min > max) throw new RangeError("min must not exceed max");
    return this.#countLessThan(left, right, max) - this.#countLessThan(left, right, min);
  }

  quantile(left: number, right: number, kth: number): number {
    this.#checkQuantile(left, right, kth);
    return wasmQuantile(...this.#queryBase(), left, right, kth) >>> 0;
  }

  /** Returns the largest value strictly less than `value`, or -1 when no such value exists. */
  predecessor(left: number, right: number, value: number): number {
    this.#checkRange(left, right);
    validateBound(value, "value");
    const count = this.#countLessThan(left, right, value);
    return count === 0 ? -1 : this.quantile(left, right, count - 1);
  }

  accessMany(
    indices: Uint32Array,
    output: Uint32Array = new Uint32Array(indices.length),
  ): Uint32Array {
    this.#assertAlive();
    if (output.length !== indices.length) throw new RangeError("output length must match queries");
    for (const index of indices) this.#checkIndex(index);
    const scratch = allocator.allocate(indices.byteLength * 2);
    try {
      const outputPointer = scratch.pointer + indices.byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, indices.length).set(indices);
      wasmAccessMany(
        ...this.#queryBase(),
        scratch.pointer,
        outputPointer,
        indices.length,
      );
      output.set(new Uint32Array(memory.buffer, outputPointer, output.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  rankMany(
    values: Uint32Array,
    ends: Uint32Array,
    output: Uint32Array = new Uint32Array(values.length),
  ): Uint32Array {
    this.#assertAlive();
    if (ends.length !== values.length || output.length !== values.length) {
      throw new RangeError("query and output lengths must match");
    }
    for (const end of ends) this.#checkEnd(end);
    const byteLength = values.byteLength;
    const scratch = allocator.allocate(byteLength * 3);
    try {
      const endsPointer = scratch.pointer + byteLength;
      const outputPointer = endsPointer + byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, values.length).set(values);
      new Uint32Array(memory.buffer, endsPointer, ends.length).set(ends);
      wasmRankMany(
        ...this.#queryBase(),
        scratch.pointer,
        endsPointer,
        outputPointer,
        values.length,
      );
      output.set(new Uint32Array(memory.buffer, outputPointer, output.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  quantileMany(
    lefts: Uint32Array,
    rights: Uint32Array,
    kths: Uint32Array,
    output: Uint32Array = new Uint32Array(lefts.length),
  ): Uint32Array {
    this.#assertAlive();
    if (
      rights.length !== lefts.length || kths.length !== lefts.length ||
      output.length !== lefts.length
    ) {
      throw new RangeError("query and output lengths must match");
    }
    for (let index = 0; index < lefts.length; index++) {
      this.#checkQuantile(lefts[index]!, rights[index]!, kths[index]!);
    }
    const byteLength = lefts.byteLength;
    const scratch = allocator.allocate(byteLength * 4);
    try {
      const rightsPointer = scratch.pointer + byteLength;
      const kthsPointer = rightsPointer + byteLength;
      const outputPointer = kthsPointer + byteLength;
      new Uint32Array(memory.buffer, scratch.pointer, lefts.length).set(lefts);
      new Uint32Array(memory.buffer, rightsPointer, rights.length).set(rights);
      new Uint32Array(memory.buffer, kthsPointer, kths.length).set(kths);
      wasmQuantileMany(
        ...this.#queryBase(),
        scratch.pointer,
        rightsPointer,
        kthsPointer,
        outputPointer,
        lefts.length,
      );
      output.set(new Uint32Array(memory.buffer, outputPointer, output.length));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#zeroAllocation);
    allocator.release(this.#rankAllocation);
    allocator.release(this.#bitsAllocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #queryBase(): [number, number, number, number, number] {
    this.#assertAlive();
    return [
      this.#bitsAllocation.pointer,
      this.#rankAllocation.pointer,
      this.#zeroAllocation.pointer,
      this.#paddedWords,
      this.#superblocks,
    ];
  }

  #countLessThan(left: number, right: number, value: number): number {
    if (value === 0) return 0;
    if (value === UINT32_LIMIT) return right - left;
    return wasmCountLessThan(...this.#queryBase(), left, right, value);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("WaveletMatrixUint32 has been disposed");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("index out of bounds");
    }
  }

  #checkEnd(end: number): void {
    if (!Number.isSafeInteger(end) || end < 0 || end > this.length) {
      throw new RangeError("end out of bounds");
    }
  }

  #checkRange(left: number, right: number): void {
    this.#assertAlive();
    if (
      !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || left > right ||
      right > this.length
    ) {
      throw new RangeError("invalid range");
    }
  }

  #checkQuantile(left: number, right: number, kth: number): void {
    this.#checkRange(left, right);
    if (!Number.isSafeInteger(kth) || kth < 0 || kth >= right - left) {
      throw new RangeError("kth out of bounds");
    }
  }
}

function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0x7fff_ffff) {
    throw new RangeError("invalid length");
  }
}

function validateValues(values: ArrayLike<number>): void {
  if (values instanceof Uint32Array) return;
  for (let index = 0; index < values.length; index++) validateUint32(values[index]!, "value");
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_LIMIT) {
    throw new RangeError(`${name} must be a Uint32`);
  }
}

function validateBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_LIMIT) {
    throw new RangeError(`${name} must be in [0, 2^32]`);
  }
}
