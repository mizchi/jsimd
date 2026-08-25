import {
  mask_and as wasmMaskAnd,
  mask_andnot as wasmMaskAndNot,
  mask_count as wasmMaskCount,
  mask_or as wasmMaskOr,
  memory,
  scan_between as wasmScanBetween,
  scan_eq as wasmScanEq,
  scan_lt as wasmScanLt,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);

interface MaskState {
  readonly allocation: Allocation;
  readonly length: number;
  readonly wordCount: number;
  alive: boolean;
}

const maskStates = new WeakMap<BitSliceMask, MaskState>();

/** A reusable Wasm-resident selection mask produced by bit-sliced predicates. */
export class BitSliceMask {
  readonly length: number;

  constructor(length: number) {
    validateLength(length);
    this.length = length;
    const wordCount = paddedWordCount(length);
    maskStates.set(this, {
      allocation: allocator.allocate(wordCount * 4),
      length,
      wordCount,
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
    const words = new Uint32Array(memory.buffer, state.allocation.pointer, state.wordCount);
    return (words[index >>> 5]! & (1 << (index & 31))) !== 0;
  }

  andAssign(other: BitSliceMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAnd(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  orAssign(other: BitSliceMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskOr(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  differenceAssign(other: BitSliceMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAndNot(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  clear(): this {
    const state = maskState(this);
    new Uint32Array(memory.buffer, state.allocation.pointer, state.wordCount).fill(0);
    return this;
  }

  toIndices(): Uint32Array {
    const state = maskState(this);
    const output = new Uint32Array(this.countOnes());
    const words = new Uint32Array(memory.buffer, state.allocation.pointer, state.wordCount);
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

/** A mostly-static bit-sliced column for unsigned values up to eight bits wide. */
export class BitSlicedColumnU8 {
  readonly length: number;
  readonly bitWidth: number;
  readonly #wordCount: number;
  readonly #planes: Allocation;
  readonly #validity: Allocation;
  #disposed = false;

  private constructor(length: number, bitWidth: number, planes: Allocation, validity: Allocation) {
    this.length = length;
    this.bitWidth = bitWidth;
    this.#wordCount = paddedWordCount(length);
    this.#planes = planes;
    this.#validity = validity;
  }

  static from(
    values: Uint8Array,
    bitWidth = 8,
    validity?: Uint8Array,
  ): BitSlicedColumnU8 {
    if (!(values instanceof Uint8Array)) throw new TypeError("values must be a Uint8Array");
    validateBitWidth(bitWidth);
    if (
      validity !== undefined &&
      (!(validity instanceof Uint8Array) || validity.length !== values.length)
    ) {
      throw new RangeError("validity must be a Uint8Array with one byte per value");
    }
    const wordCount = paddedWordCount(values.length);
    const planeWords = new Uint32Array(wordCount * bitWidth);
    const validityWords = new Uint32Array(wordCount);
    const limit = 2 ** bitWidth;
    for (let index = 0; index < values.length; index++) {
      const valid = validity === undefined || validity[index] !== 0;
      if (!valid) continue;
      const value = values[index]!;
      if (value >= limit) throw new RangeError(`value ${value} exceeds ${bitWidth}-bit width`);
      const word = index >>> 5;
      const bitMask = 1 << (index & 31);
      validityWords[word] = (validityWords[word]! | bitMask) >>> 0;
      for (let bit = 0; bit < bitWidth; bit++) {
        if (((value >>> bit) & 1) !== 0) {
          const planeWord = bit * wordCount + word;
          planeWords[planeWord] = (planeWords[planeWord]! | bitMask) >>> 0;
        }
      }
    }

    let planes: Allocation | undefined;
    let validityAllocation: Allocation | undefined;
    try {
      planes = allocator.allocate(planeWords.byteLength);
      validityAllocation = allocator.allocate(validityWords.byteLength);
      new Uint32Array(memory.buffer, planes.pointer, planeWords.length).set(planeWords);
      new Uint32Array(memory.buffer, validityAllocation.pointer, validityWords.length).set(
        validityWords,
      );
      return new BitSlicedColumnU8(values.length, bitWidth, planes, validityAllocation);
    } catch (error) {
      if (validityAllocation !== undefined) allocator.release(validityAllocation);
      if (planes !== undefined) allocator.release(planes);
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(index: number): number | undefined {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("column index out of bounds");
    }
    const validity = new Uint32Array(memory.buffer, this.#validity.pointer, this.#wordCount);
    if ((validity[index >>> 5]! & (1 << (index & 31))) === 0) return undefined;
    const planes = new Uint32Array(
      memory.buffer,
      this.#planes.pointer,
      this.#wordCount * this.bitWidth,
    );
    let value = 0;
    for (let bit = 0; bit < this.bitWidth; bit++) {
      if ((planes[bit * this.#wordCount + (index >>> 5)]! & (1 << (index & 31))) !== 0) {
        value |= 1 << bit;
      }
    }
    return value;
  }

  eq(value: number, output: BitSliceMask): BitSliceMask {
    this.#assertAlive();
    const target = validatePredicate(value);
    const mask = outputState(output, this.length);
    if (target < 0 || target >= 2 ** this.bitWidth) return output.clear();
    wasmScanEq(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      target,
    );
    return output;
  }

  lt(value: number, output: BitSliceMask): BitSliceMask {
    this.#assertAlive();
    const target = validatePredicate(value);
    const mask = outputState(output, this.length);
    if (target <= 0) return output.clear();
    wasmScanLt(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      Math.min(target, 2 ** this.bitWidth),
    );
    return output;
  }

  between(minimum: number, maximum: number, output: BitSliceMask): BitSliceMask {
    this.#assertAlive();
    const min = validatePredicate(minimum);
    const max = validatePredicate(maximum);
    const mask = outputState(output, this.length);
    const limit = 2 ** this.bitWidth;
    if (min > max || max < 0 || min >= limit) return output.clear();
    wasmScanBetween(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      Math.max(0, min),
      Math.min(limit, max + 1),
    );
    return output;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#validity);
    allocator.release(this.#planes);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitSlicedColumnU8 has been disposed");
  }
}

function maskState(mask: BitSliceMask): MaskState {
  const state = maskStates.get(mask);
  if (state === undefined || !state.alive) throw new Error("BitSliceMask has been disposed");
  return state;
}

function outputState(mask: BitSliceMask, length: number): MaskState {
  const state = maskState(mask);
  if (state.length !== length) throw new RangeError("mask and column lengths must match");
  return state;
}

function compatibleMasks(left: BitSliceMask, right: BitSliceMask): [MaskState, MaskState] {
  const leftState = maskState(left);
  const rightState = maskState(right);
  if (leftState.length !== rightState.length) throw new RangeError("mask lengths must match");
  return [leftState, rightState];
}

function paddedWordCount(length: number): number {
  return ((Math.ceil(length / 32) + 3) >>> 2) << 2;
}

function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new RangeError("invalid bit mask length");
  }
}

function validateBitWidth(bitWidth: number): void {
  if (!Number.isSafeInteger(bitWidth) || bitWidth < 1 || bitWidth > 8) {
    throw new RangeError("bit width must be between 1 and 8");
  }
}

function validatePredicate(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("predicate must be a safe integer");
  return value;
}
