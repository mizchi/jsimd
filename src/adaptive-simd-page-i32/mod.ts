import {
  decode_for as wasmDecodeFor,
  decode_raw as wasmDecodeRaw,
  gather_for as wasmGatherFor,
  gather_raw as wasmGatherRaw,
  mask_and as wasmMaskAnd,
  mask_andnot as wasmMaskAndNot,
  mask_count as wasmMaskCount,
  mask_not as wasmMaskNot,
  mask_or as wasmMaskOr,
  memory,
  scan_between_for as wasmScanBetweenFor,
  scan_between_raw as wasmScanBetweenRaw,
  scan_eq_for as wasmScanEqFor,
  scan_eq_raw as wasmScanEqRaw,
  scan_lt_for as wasmScanLtFor,
  scan_lt_raw as wasmScanLtRaw,
  sum_for as wasmSumFor,
  sum_raw as wasmSumRaw,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const MAX_PAGE_LENGTH = 256;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const allocator = new LinearMemoryAllocator(memory);

export const AdaptivePageEncoding: Readonly<{
  Constant: "constant";
  FrameOfReference: "frame-of-reference";
  Raw: "raw";
}> = Object.freeze(
  {
    Constant: "constant",
    FrameOfReference: "frame-of-reference",
    Raw: "raw",
  } as const,
);

export type AdaptivePageEncoding = typeof AdaptivePageEncoding[keyof typeof AdaptivePageEncoding];

interface MaskState {
  readonly allocation: Allocation;
  readonly length: number;
  readonly wordCount: number;
  readonly logicalWords: number;
  alive: boolean;
}

const maskStates = new WeakMap<SimdPageMask, MaskState>();

/** A reusable Wasm-resident selection mask for one adaptive page. */
export class SimdPageMask {
  readonly length: number;

  constructor(length: number) {
    validatePageLength(length);
    this.length = length;
    const logicalWords = Math.ceil(length / 32);
    const wordCount = (logicalWords + 3) & ~3;
    maskStates.set(this, {
      allocation: allocator.allocate(wordCount * 4),
      length,
      wordCount,
      logicalWords,
      alive: true,
    });
  }

  countOnes(): number {
    const state = maskState(this);
    return wasmMaskCount(state.allocation.pointer, state.wordCount);
  }

  has(index: number): boolean {
    const state = maskState(this);
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.length) {
      throw new RangeError("mask index out of bounds");
    }
    return (maskWords(state)[index >>> 5]! & (1 << (index & 31))) !== 0;
  }

  clear(): this {
    maskWords(maskState(this)).fill(0);
    return this;
  }

  fill(): this {
    const state = maskState(this);
    const words = maskWords(state);
    words.fill(0);
    words.fill(0xffff_ffff, 0, state.logicalWords);
    trimMaskTail(words, state.length, state.logicalWords);
    return this;
  }

  andAssign(other: SimdPageMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAnd(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  orAssign(other: SimdPageMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskOr(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  differenceAssign(other: SimdPageMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAndNot(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  invert(): this {
    const state = maskState(this);
    wasmMaskNot(state.allocation.pointer, state.wordCount);
    const words = maskWords(state);
    for (let word = state.logicalWords; word < state.wordCount; word++) words[word] = 0;
    trimMaskTail(words, state.length, state.logicalWords);
    return this;
  }

  toIndices(): Uint32Array {
    const state = maskState(this);
    const output = new Uint32Array(this.countOnes());
    const words = maskWords(state);
    let written = 0;
    for (let index = 0; index < state.length; index++) {
      if ((words[index >>> 5]! & (1 << (index & 31))) !== 0) output[written++] = index;
    }
    return output;
  }

  dispose(): void {
    const state = maskStates.get(this);
    if (state === undefined || !state.alive) return;
    state.alive = false;
    allocator.release(state.allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** An immutable page that chooses a compact physical encoding from local i32 statistics. */
export class AdaptiveSimdPageI32 {
  readonly length: number;
  readonly min: number;
  readonly max: number;
  readonly encoding: AdaptivePageEncoding;
  readonly bitWidth: number;
  readonly encodedBytes: number;
  readonly #allocation: Allocation;
  readonly #packedWords: number;
  #disposed = false;

  private constructor(values: Int32Array) {
    this.length = values.length;
    let minimum = values[0] ?? 0;
    let maximum = minimum;
    for (let index = 1; index < values.length; index++) {
      const value = values[index]!;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    this.min = minimum;
    this.max = maximum;

    const range = maximum - minimum;
    if (values.length === 0 || range === 0) {
      this.encoding = AdaptivePageEncoding.Constant;
      this.bitWidth = 0;
      this.encodedBytes = 0;
      this.#packedWords = 0;
      this.#allocation = allocator.allocate(0);
      return;
    }

    const bitWidth = Math.ceil(Math.log2(range + 1));
    if (bitWidth <= 16) {
      this.encoding = AdaptivePageEncoding.FrameOfReference;
      this.bitWidth = bitWidth;
      const packed = packFrameOfReference(values, minimum, bitWidth);
      this.#packedWords = packed.length;
      this.encodedBytes = packed.byteLength;
      const allocation = allocator.allocate(packed.byteLength);
      try {
        new Uint32Array(memory.buffer, allocation.pointer, packed.length).set(packed);
      } catch (error) {
        allocator.release(allocation);
        throw error;
      }
      this.#allocation = allocation;
      return;
    }

    this.encoding = AdaptivePageEncoding.Raw;
    this.bitWidth = 32;
    this.#packedWords = 0;
    this.encodedBytes = values.byteLength;
    const paddedLength = (values.length + 3) & ~3;
    const allocation = allocator.allocate(paddedLength * 4);
    try {
      new Int32Array(memory.buffer, allocation.pointer, paddedLength).set(values);
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  static from(values: ArrayLike<number>): AdaptiveSimdPageI32 {
    validatePageLength(values.length);
    const normalized = new Int32Array(values.length);
    for (let index = 0; index < values.length; index++) {
      normalized[index] = validateI32(values[index]!);
    }
    return new AdaptiveSimdPageI32(normalized);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(index: number): number {
    this.#checkIndex(index);
    if (this.encoding === AdaptivePageEncoding.Constant) return this.min;
    if (this.encoding === AdaptivePageEncoding.Raw) {
      return new Int32Array(memory.buffer, this.#allocation.pointer, this.length)[index]!;
    }
    const words = new Uint32Array(memory.buffer, this.#allocation.pointer, this.#packedWords);
    return this.min + packedAt(words, this.bitWidth, index);
  }

  decodeInto(output: Int32Array): number {
    this.#assertAlive();
    if (!(output instanceof Int32Array) || output.length < this.length) {
      throw new RangeError("output must be an Int32Array large enough for the page");
    }
    if (this.encoding === AdaptivePageEncoding.Constant) {
      output.fill(this.min, 0, this.length);
      return this.length;
    }
    const scratch = allocator.allocate(this.length * 4);
    try {
      if (this.encoding === AdaptivePageEncoding.Raw) {
        wasmDecodeRaw(this.#allocation.pointer, scratch.pointer, this.length);
      } else {
        wasmDecodeFor(
          this.#allocation.pointer,
          scratch.pointer,
          this.length,
          this.bitWidth,
          this.min,
        );
      }
      output.set(new Int32Array(memory.buffer, scratch.pointer, this.length));
      return this.length;
    } finally {
      allocator.release(scratch);
    }
  }

  toInt32Array(): Int32Array {
    const output = new Int32Array(this.length);
    this.decodeInto(output);
    return output;
  }

  sum(): number {
    this.#assertAlive();
    if (this.encoding === AdaptivePageEncoding.Constant) return this.min * this.length;
    const sum = this.encoding === AdaptivePageEncoding.Raw
      ? wasmSumRaw(this.#allocation.pointer, this.length)
      : wasmSumFor(this.#allocation.pointer, this.length, this.bitWidth, this.min);
    return Number(sum);
  }

  scanEq(value: number, output: SimdPageMask): SimdPageMask {
    this.#assertAlive();
    const target = validatePredicate(value);
    const mask = outputState(output, this.length);
    output.clear();
    if (target < this.min || target > this.max) return output;
    if (this.encoding === AdaptivePageEncoding.Constant) return output.fill();
    if (this.encoding === AdaptivePageEncoding.Raw) {
      wasmScanEqRaw(this.#allocation.pointer, mask.allocation.pointer, this.length, target);
    } else {
      wasmScanEqFor(
        this.#allocation.pointer,
        mask.allocation.pointer,
        this.length,
        this.bitWidth,
        this.min,
        target,
      );
    }
    return output;
  }

  scanLt(value: number, output: SimdPageMask): SimdPageMask {
    this.#assertAlive();
    const target = validatePredicate(value);
    const mask = outputState(output, this.length);
    output.clear();
    if (target <= this.min) return output;
    if (target > this.max) return output.fill();
    if (this.encoding === AdaptivePageEncoding.Constant) return output.fill();
    this.#scanLtKernel(target, mask);
    return output;
  }

  /** Selects values in the half-open interval `[minimum, maximum)`. */
  scanBetween(minimum: number, maximum: number, output: SimdPageMask): SimdPageMask {
    this.#assertAlive();
    const lower = validatePredicate(minimum);
    const upper = validatePredicate(maximum);
    const mask = outputState(output, this.length);
    output.clear();
    if (lower >= upper || upper <= this.min || lower > this.max) return output;
    if (lower <= this.min && upper > this.max) return output.fill();
    if (this.encoding === AdaptivePageEncoding.Constant) return output.fill();
    if (lower <= this.min) {
      this.#scanLtKernel(upper, mask);
      return output;
    }
    if (upper > this.max) {
      this.#scanLtKernel(lower, mask);
      return output.invert();
    }
    if (this.encoding === AdaptivePageEncoding.Raw) {
      wasmScanBetweenRaw(
        this.#allocation.pointer,
        mask.allocation.pointer,
        this.length,
        lower,
        upper,
      );
    } else {
      wasmScanBetweenFor(
        this.#allocation.pointer,
        mask.allocation.pointer,
        this.length,
        this.bitWidth,
        this.min,
        lower,
        upper,
      );
    }
    return output;
  }

  gatherInto(selection: SimdPageMask, output: Int32Array): number {
    this.#assertAlive();
    const mask = outputState(selection, this.length);
    const count = selection.countOnes();
    if (!(output instanceof Int32Array) || output.length < count) {
      throw new RangeError("output must be an Int32Array large enough for selected values");
    }
    if (count === 0) return 0;
    if (this.encoding === AdaptivePageEncoding.Constant) {
      output.fill(this.min, 0, count);
      return count;
    }
    const scratch = allocator.allocate(count * 4);
    try {
      const written = this.encoding === AdaptivePageEncoding.Raw
        ? wasmGatherRaw(
          this.#allocation.pointer,
          mask.allocation.pointer,
          scratch.pointer,
          this.length,
        )
        : wasmGatherFor(
          this.#allocation.pointer,
          mask.allocation.pointer,
          scratch.pointer,
          this.length,
          this.bitWidth,
          this.min,
        );
      output.set(new Int32Array(memory.buffer, scratch.pointer, written));
      return written;
    } finally {
      allocator.release(scratch);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #scanLtKernel(value: number, mask: MaskState): void {
    if (this.encoding === AdaptivePageEncoding.Raw) {
      wasmScanLtRaw(this.#allocation.pointer, mask.allocation.pointer, this.length, value);
    } else {
      wasmScanLtFor(
        this.#allocation.pointer,
        mask.allocation.pointer,
        this.length,
        this.bitWidth,
        this.min,
        value,
      );
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("AdaptiveSimdPageI32 has been disposed");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("page index out of bounds");
    }
  }
}

function packFrameOfReference(values: Int32Array, base: number, bitWidth: number): Uint32Array {
  const words = new Uint32Array(Math.ceil(values.length * bitWidth / 32));
  for (let index = 0; index < values.length; index++) {
    const delta = values[index]! - base;
    const bit = index * bitWidth;
    const word = bit >>> 5;
    const shift = bit & 31;
    words[word] = (words[word]! | (delta << shift)) >>> 0;
    if (shift + bitWidth > 32) {
      words[word + 1] = (words[word + 1]! | (delta >>> (32 - shift))) >>> 0;
    }
  }
  return words;
}

function packedAt(words: Uint32Array, bitWidth: number, index: number): number {
  const bit = index * bitWidth;
  const word = bit >>> 5;
  const shift = bit & 31;
  let value = words[word]! >>> shift;
  if (shift + bitWidth > 32) value |= words[word + 1]! << (32 - shift);
  return value & ((1 << bitWidth) - 1);
}

function maskState(mask: SimdPageMask): MaskState {
  const state = maskStates.get(mask);
  if (state === undefined || !state.alive) throw new Error("SimdPageMask has been disposed");
  return state;
}

function outputState(mask: SimdPageMask, length: number): MaskState {
  const state = maskState(mask);
  if (state.length !== length) throw new RangeError("mask and page lengths must match");
  return state;
}

function compatibleMasks(left: SimdPageMask, right: SimdPageMask): [MaskState, MaskState] {
  const leftState = maskState(left);
  const rightState = maskState(right);
  if (leftState.length !== rightState.length) throw new RangeError("mask lengths must match");
  return [leftState, rightState];
}

function maskWords(state: MaskState): Uint32Array {
  return new Uint32Array(memory.buffer, state.allocation.pointer, state.wordCount);
}

function trimMaskTail(words: Uint32Array, length: number, logicalWords: number): void {
  if (logicalWords === 0 || (length & 31) === 0) return;
  words[logicalWords - 1] = (words[logicalWords - 1]! & (2 ** (length & 31) - 1)) >>> 0;
}

function validatePageLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PAGE_LENGTH) {
    throw new RangeError(`page length must be between 0 and ${MAX_PAGE_LENGTH}`);
  }
}

function validateI32(value: number): number {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError("page values must be signed 32-bit integers");
  }
  return value;
}

function validatePredicate(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("predicate must be a safe integer");
  return value;
}
