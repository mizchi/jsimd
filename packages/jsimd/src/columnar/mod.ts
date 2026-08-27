import {
  gather_i32_constant as wasmGatherI32Constant,
  gather_i32_for as wasmGatherI32For,
  gather_i32_raw as wasmGatherI32Raw,
  gather_u8 as wasmGatherU8,
  mask_and as wasmMaskAnd,
  mask_andnot as wasmMaskAndNot,
  mask_count as wasmMaskCount,
  mask_not as wasmMaskNot,
  mask_or as wasmMaskOr,
  mask_positions_into as wasmMaskPositionsInto,
  memory,
  scan_i32_between_for as wasmScanI32BetweenFor,
  scan_i32_between_raw as wasmScanI32BetweenRaw,
  scan_i32_eq_for as wasmScanI32EqFor,
  scan_i32_eq_raw as wasmScanI32EqRaw,
  scan_i32_lt_for as wasmScanI32LtFor,
  scan_i32_lt_raw as wasmScanI32LtRaw,
  scan_u32_between_for as wasmScanU32BetweenFor,
  scan_u32_between_raw as wasmScanU32BetweenRaw,
  scan_u32_eq_for as wasmScanU32EqFor,
  scan_u32_eq_raw as wasmScanU32EqRaw,
  scan_u32_lt_for as wasmScanU32LtFor,
  scan_u32_lt_raw as wasmScanU32LtRaw,
  scan_u8_between as wasmScanU8Between,
  scan_u8_eq as wasmScanU8Eq,
  scan_u8_lt as wasmScanU8Lt,
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
  invalidSnapshot,
  SnapshotKind,
  uint32Payload,
} from "../internal/snapshot.ts";

const PAGE_SIZE = 256;
const WORDS_PER_PAGE = PAGE_SIZE / 32;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;
const U32_MAX = 0xffff_ffff;
const allocator = new LinearMemoryAllocator(memory);

interface MaskState {
  readonly allocation: Allocation;
  readonly length: number;
  readonly logicalWords: number;
  readonly wordCount: number;
  alive: boolean;
}

const maskStates = new WeakMap<SelectionMask, MaskState>();

/** A reusable Wasm-resident row selection shared by all columnar types. */
export class SelectionMask {
  readonly length: number;

  constructor(length: number) {
    validateLength(length);
    this.length = length;
    const logicalWords = Math.ceil(length / 32);
    const wordCount = paddedWordCount(length);
    maskStates.set(this, {
      allocation: allocator.allocate(wordCount * 4),
      length,
      logicalWords,
      wordCount,
      alive: true,
    });
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
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
    trimMaskTail(state);
    return this;
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

  andAssign(other: SelectionMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAnd(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  orAssign(other: SelectionMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskOr(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  andNotAssign(other: SelectionMask): this {
    const [left, right] = compatibleMasks(this, other);
    wasmMaskAndNot(left.allocation.pointer, right.allocation.pointer, left.wordCount);
    return this;
  }

  invert(): this {
    const state = maskState(this);
    wasmMaskNot(state.allocation.pointer, state.wordCount);
    trimMaskTail(state);
    return this;
  }

  /** Writes selected row positions without exposing the resident mask. */
  positionsInto(output: Uint32Array): number {
    const state = maskState(this);
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    const count = this.countOnes();
    if (output.length < count) {
      throw new RangeError("output must be large enough for all selected positions");
    }
    if (count === 0) return 0;
    const scratch = allocator.allocate(count * 4);
    try {
      const written = wasmMaskPositionsInto(
        state.allocation.pointer,
        state.wordCount,
        scratch.pointer,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer, written), 0);
      return written;
    } finally {
      allocator.release(scratch);
    }
  }

  toIndices(): Uint32Array {
    const output = new Uint32Array(this.countOnes());
    this.positionsInto(output);
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

export const AdaptiveI32Encoding: Readonly<{
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

export type AdaptiveI32Encoding = typeof AdaptiveI32Encoding[keyof typeof AdaptiveI32Encoding];

interface I32Page {
  readonly length: number;
  readonly min: number;
  readonly max: number;
  readonly encoding: AdaptiveI32Encoding;
  readonly bitWidth: number;
  readonly packedWords: number;
  readonly allocation: Allocation;
}

export interface AdaptiveI32EncodingCounts {
  readonly constant: number;
  readonly frameOfReference: number;
  readonly raw: number;
}

/** An immutable i32 column with 256-row zone-mapped adaptive pages. */
export class AdaptiveI32Column {
  readonly length: number;
  readonly pageSize = PAGE_SIZE;
  readonly pageCount: number;
  readonly min: number;
  readonly max: number;
  readonly encodedBytes: number;
  readonly #pages: readonly I32Page[];
  #disposed = false;

  private constructor(pages: readonly I32Page[], length: number) {
    this.#pages = pages;
    this.length = length;
    this.pageCount = pages.length;
    let minimum = pages[0]?.min ?? 0;
    let maximum = pages[0]?.max ?? 0;
    let encodedBytes = 0;
    for (const page of pages) {
      if (page.min < minimum) minimum = page.min;
      if (page.max > maximum) maximum = page.max;
      encodedBytes += page.encoding === AdaptiveI32Encoding.Constant
        ? 0
        : page.encoding === AdaptiveI32Encoding.Raw
        ? page.length * 4
        : page.packedWords * 4;
    }
    this.min = minimum;
    this.max = maximum;
    this.encodedBytes = encodedBytes;
  }

  static from(values: ArrayLike<number>): AdaptiveI32Column {
    validateLength(values.length);
    const pages: I32Page[] = [];
    try {
      for (let offset = 0; offset < values.length; offset += PAGE_SIZE) {
        const length = Math.min(PAGE_SIZE, values.length - offset);
        const pageValues = new Int32Array(length);
        for (let index = 0; index < length; index++) {
          pageValues[index] = validateI32(values[offset + index]!);
        }
        pages.push(createI32Page(pageValues));
      }
      return new AdaptiveI32Column(pages, values.length);
    } catch (error) {
      for (const page of pages) allocator.release(page.allocation);
      throw error;
    }
  }

  static fromSnapshot(snapshot: Uint8Array): AdaptiveI32Column {
    const { shape, payloads } = decodeSnapshot(
      snapshot,
      SnapshotKind.AdaptiveI32Column,
      2,
      2,
    );
    const length = shape[0]!;
    const pageCount = shape[1]!;
    validateColumnSnapshotShape(length, pageCount);
    const pages = restoreI32Pages(length, pageCount, payloads[0]!, payloads[1]!);
    return new AdaptiveI32Column(pages, length);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  serialize(): Uint8Array {
    this.#assertAlive();
    return serializeAdaptivePages(
      SnapshotKind.AdaptiveI32Column,
      this.length,
      this.#pages,
    );
  }

  get(index: number): number {
    this.#checkIndex(index);
    const page = this.#pages[index >>> 8]!;
    const local = index & 255;
    if (page.encoding === AdaptiveI32Encoding.Constant) return page.min;
    if (page.encoding === AdaptiveI32Encoding.Raw) {
      return new Int32Array(memory.buffer, page.allocation.pointer, page.length)[local]!;
    }
    const words = new Uint32Array(
      memory.buffer,
      page.allocation.pointer,
      page.packedWords,
    );
    return page.min + packedAt(words, page.bitWidth, local);
  }

  /** Materializes selected values in row order without exposing resident pages. */
  gatherInto(selection: SelectionMask, output: Int32Array): number {
    if (!(output instanceof Int32Array)) throw new TypeError("output must be an Int32Array");
    return gatherAdaptivePages(this.#pages, this.#outputState(selection), output);
  }

  encodingCounts(): AdaptiveI32EncodingCounts {
    this.#assertAlive();
    let constant = 0;
    let frameOfReference = 0;
    let raw = 0;
    for (const page of this.#pages) {
      if (page.encoding === AdaptiveI32Encoding.Constant) constant++;
      else if (page.encoding === AdaptiveI32Encoding.FrameOfReference) frameOfReference++;
      else raw++;
    }
    return Object.freeze({ constant, frameOfReference, raw });
  }

  scanEq(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    output.clear();
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (target < page.min || target > page.max) continue;
      if (page.min === page.max) setPageFull(mask, pageIndex, page.length);
      else if (page.encoding === AdaptiveI32Encoding.Raw) {
        wasmScanI32EqRaw(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          target,
        );
      } else {
        wasmScanI32EqFor(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          page.bitWidth,
          page.min,
          target,
        );
      }
    }
    trimMaskTail(mask);
    return output;
  }

  scanLt(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    output.clear();
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (target <= page.min) continue;
      if (target > page.max) {
        setPageFull(mask, pageIndex, page.length);
      } else if (page.encoding === AdaptiveI32Encoding.Raw) {
        wasmScanI32LtRaw(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          target,
        );
      } else {
        wasmScanI32LtFor(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          page.bitWidth,
          page.min,
          target,
        );
      }
    }
    trimMaskTail(mask);
    return output;
  }

  /** Selects values in the half-open interval `[minimum, maximum)`. */
  scanBetween(minimum: number, maximum: number, output: SelectionMask): SelectionMask {
    const min = validatePredicate(minimum);
    const max = validatePredicate(maximum);
    const mask = this.#outputState(output);
    output.clear();
    if (min >= max) return output;
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (max <= page.min || min > page.max) continue;
      if (min <= page.min && max > page.max) {
        setPageFull(mask, pageIndex, page.length);
      } else if (min <= page.min) {
        scanI32PageLt(page, pageOutputPointer(mask, pageIndex), max);
      } else if (max > page.max) {
        scanI32PageLt(page, pageOutputPointer(mask, pageIndex), min);
        invertPage(mask, pageIndex, page.length);
      } else if (page.encoding === AdaptiveI32Encoding.Raw) {
        wasmScanI32BetweenRaw(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          min,
          max,
        );
      } else {
        wasmScanI32BetweenFor(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          page.bitWidth,
          page.min,
          min,
          max,
        );
      }
    }
    trimMaskTail(mask);
    return output;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const page of this.#pages) allocator.release(page.allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #outputState(output: SelectionMask): MaskState {
    this.#assertAlive();
    const state = maskState(output);
    if (state.length !== this.length) throw new RangeError("mask and column lengths must match");
    return state;
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("column index out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("AdaptiveI32Column has been disposed");
  }
}

export const AdaptiveU32Encoding: Readonly<{
  Constant: "constant";
  FrameOfReference: "frame-of-reference";
  Raw: "raw";
}> = AdaptiveI32Encoding;

export type AdaptiveU32Encoding = typeof AdaptiveU32Encoding[keyof typeof AdaptiveU32Encoding];

interface U32Page {
  readonly length: number;
  readonly min: number;
  readonly max: number;
  readonly encoding: AdaptiveU32Encoding;
  readonly bitWidth: number;
  readonly packedWords: number;
  readonly allocation: Allocation;
}

export interface AdaptiveU32EncodingCounts {
  readonly constant: number;
  readonly frameOfReference: number;
  readonly raw: number;
}

/** An immutable u32 column with 256-row zone-mapped adaptive pages. */
export class AdaptiveU32Column {
  readonly length: number;
  readonly pageSize = PAGE_SIZE;
  readonly pageCount: number;
  readonly min: number;
  readonly max: number;
  readonly encodedBytes: number;
  readonly #pages: readonly U32Page[];
  #disposed = false;

  private constructor(pages: readonly U32Page[], length: number) {
    this.#pages = pages;
    this.length = length;
    this.pageCount = pages.length;
    let minimum = pages[0]?.min ?? 0;
    let maximum = pages[0]?.max ?? 0;
    let encodedBytes = 0;
    for (const page of pages) {
      if (page.min < minimum) minimum = page.min;
      if (page.max > maximum) maximum = page.max;
      encodedBytes += page.encoding === AdaptiveU32Encoding.Constant
        ? 0
        : page.encoding === AdaptiveU32Encoding.Raw
        ? page.length * 4
        : page.packedWords * 4;
    }
    this.min = minimum;
    this.max = maximum;
    this.encodedBytes = encodedBytes;
  }

  static from(values: ArrayLike<number>): AdaptiveU32Column {
    validateLength(values.length);
    const pages: U32Page[] = [];
    try {
      for (let offset = 0; offset < values.length; offset += PAGE_SIZE) {
        const length = Math.min(PAGE_SIZE, values.length - offset);
        const pageValues = new Uint32Array(length);
        for (let index = 0; index < length; index++) {
          pageValues[index] = validateU32(values[offset + index]!);
        }
        pages.push(createU32Page(pageValues));
      }
      return new AdaptiveU32Column(pages, values.length);
    } catch (error) {
      for (const page of pages) allocator.release(page.allocation);
      throw error;
    }
  }

  static fromSnapshot(snapshot: Uint8Array): AdaptiveU32Column {
    const { shape, payloads } = decodeSnapshot(
      snapshot,
      SnapshotKind.AdaptiveU32Column,
      2,
      2,
    );
    const length = shape[0]!;
    const pageCount = shape[1]!;
    validateColumnSnapshotShape(length, pageCount);
    const pages = restoreU32Pages(length, pageCount, payloads[0]!, payloads[1]!);
    return new AdaptiveU32Column(pages, length);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  serialize(): Uint8Array {
    this.#assertAlive();
    return serializeAdaptivePages(
      SnapshotKind.AdaptiveU32Column,
      this.length,
      this.#pages,
    );
  }

  get(index: number): number {
    this.#checkIndex(index);
    const page = this.#pages[index >>> 8]!;
    const local = index & 255;
    if (page.encoding === AdaptiveU32Encoding.Constant) return page.min;
    if (page.encoding === AdaptiveU32Encoding.Raw) {
      return new Uint32Array(memory.buffer, page.allocation.pointer, page.length)[local]!;
    }
    const words = new Uint32Array(
      memory.buffer,
      page.allocation.pointer,
      page.packedWords,
    );
    return page.min + packedAt(words, page.bitWidth, local);
  }

  /** Materializes selected values in row order without exposing resident pages. */
  gatherInto(selection: SelectionMask, output: Uint32Array): number {
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    return gatherAdaptivePages(this.#pages, this.#outputState(selection), output);
  }

  encodingCounts(): AdaptiveU32EncodingCounts {
    this.#assertAlive();
    let constant = 0;
    let frameOfReference = 0;
    let raw = 0;
    for (const page of this.#pages) {
      if (page.encoding === AdaptiveU32Encoding.Constant) constant++;
      else if (page.encoding === AdaptiveU32Encoding.FrameOfReference) frameOfReference++;
      else raw++;
    }
    return Object.freeze({ constant, frameOfReference, raw });
  }

  scanEq(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    output.clear();
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (target < page.min || target > page.max) continue;
      if (page.min === page.max) setPageFull(mask, pageIndex, page.length);
      else if (page.encoding === AdaptiveU32Encoding.Raw) {
        wasmScanU32EqRaw(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          target,
        );
      } else {
        wasmScanU32EqFor(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          page.bitWidth,
          page.min,
          target,
        );
      }
    }
    trimMaskTail(mask);
    return output;
  }

  scanLt(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    output.clear();
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (target <= page.min) continue;
      if (target > page.max) setPageFull(mask, pageIndex, page.length);
      else scanU32PageLt(page, pageOutputPointer(mask, pageIndex), target);
    }
    trimMaskTail(mask);
    return output;
  }

  /** Selects values in the half-open interval `[minimum, maximum)`. */
  scanBetween(minimum: number, maximum: number, output: SelectionMask): SelectionMask {
    const min = validatePredicate(minimum);
    const max = validatePredicate(maximum);
    const mask = this.#outputState(output);
    output.clear();
    if (min >= max) return output;
    for (let pageIndex = 0; pageIndex < this.#pages.length; pageIndex++) {
      const page = this.#pages[pageIndex]!;
      if (max <= page.min || min > page.max) continue;
      if (min <= page.min && max > page.max) {
        setPageFull(mask, pageIndex, page.length);
      } else if (min <= page.min) {
        scanU32PageLt(page, pageOutputPointer(mask, pageIndex), max);
      } else if (max > page.max) {
        scanU32PageLt(page, pageOutputPointer(mask, pageIndex), min);
        invertPage(mask, pageIndex, page.length);
      } else if (page.encoding === AdaptiveU32Encoding.Raw) {
        wasmScanU32BetweenRaw(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          min,
          max,
        );
      } else {
        wasmScanU32BetweenFor(
          page.allocation.pointer,
          pageOutputPointer(mask, pageIndex),
          page.length,
          page.bitWidth,
          page.min,
          min,
          max,
        );
      }
    }
    trimMaskTail(mask);
    return output;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const page of this.#pages) allocator.release(page.allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #outputState(output: SelectionMask): MaskState {
    this.#assertAlive();
    const state = maskState(output);
    if (state.length !== this.length) throw new RangeError("mask and column lengths must match");
    return state;
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("column index out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("AdaptiveU32Column has been disposed");
  }
}

/** A mostly-static nullable u8 column stored as bit planes. */
export class BitSlicedU8Column {
  readonly length: number;
  readonly bitWidth: number;
  readonly encodedBytes: number;
  readonly #wordCount: number;
  readonly #planes: Allocation;
  readonly #validity: Allocation;
  #disposed = false;

  private constructor(
    length: number,
    bitWidth: number,
    wordCount: number,
    planes: Allocation,
    validity: Allocation,
  ) {
    this.length = length;
    this.bitWidth = bitWidth;
    this.#wordCount = wordCount;
    this.#planes = planes;
    this.#validity = validity;
    this.encodedBytes = wordCount * 4 * (bitWidth + 1);
  }

  static from(
    values: Uint8Array,
    bitWidth = 8,
    validity?: Uint8Array,
  ): BitSlicedU8Column {
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
      if (validity !== undefined && validity[index] === 0) continue;
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
    let valid: Allocation | undefined;
    try {
      planes = allocator.allocate(planeWords.byteLength);
      valid = allocator.allocate(validityWords.byteLength);
      new Uint32Array(memory.buffer, planes.pointer, planeWords.length).set(planeWords);
      new Uint32Array(memory.buffer, valid.pointer, validityWords.length).set(validityWords);
      return new BitSlicedU8Column(values.length, bitWidth, wordCount, planes, valid);
    } catch (error) {
      if (valid !== undefined) allocator.release(valid);
      if (planes !== undefined) allocator.release(planes);
      throw error;
    }
  }

  static fromSnapshot(snapshot: Uint8Array): BitSlicedU8Column {
    const { shape, payloads } = decodeSnapshot(
      snapshot,
      SnapshotKind.BitSlicedU8Column,
      3,
      2,
    );
    const length = shape[0]!;
    const bitWidth = shape[1]!;
    const wordCount = shape[2]!;
    validateLength(length);
    validateBitWidth(bitWidth);
    if (wordCount !== paddedWordCount(length)) {
      throw invalidSnapshot("invalid bit-sliced word count");
    }
    expectPayloadBytes(payloads[0]!, wordCount * bitWidth * 4, "bit-sliced planes");
    expectPayloadBytes(payloads[1]!, wordCount * 4, "bit-sliced validity");
    const planeWords = uint32Payload(payloads[0]!, "bit-sliced planes");
    const validityWords = uint32Payload(payloads[1]!, "bit-sliced validity");
    validateBitSlicedSnapshot(length, bitWidth, wordCount, planeWords, validityWords);
    let planes: Allocation | undefined;
    let validity: Allocation | undefined;
    try {
      planes = allocator.allocate(planeWords.byteLength);
      validity = allocator.allocate(validityWords.byteLength);
      new Uint32Array(memory.buffer, planes.pointer, planeWords.length).set(planeWords);
      new Uint32Array(memory.buffer, validity.pointer, validityWords.length).set(validityWords);
      return new BitSlicedU8Column(length, bitWidth, wordCount, planes, validity);
    } catch (error) {
      if (validity !== undefined) allocator.release(validity);
      if (planes !== undefined) allocator.release(planes);
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  serialize(): Uint8Array {
    this.#assertAlive();
    return encodeSnapshot(
      SnapshotKind.BitSlicedU8Column,
      [this.length, this.bitWidth, this.#wordCount],
      [
        new Uint8Array(
          memory.buffer,
          this.#planes.pointer,
          this.#wordCount * this.bitWidth * 4,
        ),
        new Uint8Array(memory.buffer, this.#validity.pointer, this.#wordCount * 4),
      ],
    );
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

  /** Materializes selected values and optionally writes one-byte validity flags. */
  gatherInto(
    selection: SelectionMask,
    output: Uint8Array,
    validityOutput?: Uint8Array,
  ): number {
    if (!(output instanceof Uint8Array)) throw new TypeError("output must be a Uint8Array");
    if (validityOutput !== undefined && !(validityOutput instanceof Uint8Array)) {
      throw new TypeError("validityOutput must be a Uint8Array");
    }
    const mask = this.#outputState(selection);
    const count = selection.countOnes();
    if (output.length < count || (validityOutput !== undefined && validityOutput.length < count)) {
      throw new RangeError("outputs must be large enough for all selected values");
    }
    if (count === 0) return 0;
    const scratch = allocator.allocate(count * 2);
    try {
      const written = wasmGatherU8(
        this.#planes.pointer,
        this.#validity.pointer,
        mask.allocation.pointer,
        this.#wordCount,
        this.bitWidth,
        scratch.pointer,
        scratch.pointer + count,
      );
      output.set(new Uint8Array(memory.buffer, scratch.pointer, written), 0);
      if (validityOutput !== undefined) {
        validityOutput.set(
          new Uint8Array(memory.buffer, scratch.pointer + count, written),
          0,
        );
      }
      return written;
    } finally {
      allocator.release(scratch);
    }
  }

  scanEq(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    if (target < 0 || target >= 2 ** this.bitWidth) return output.clear();
    wasmScanU8Eq(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      target,
    );
    return output;
  }

  scanLt(value: number, output: SelectionMask): SelectionMask {
    const target = validatePredicate(value);
    const mask = this.#outputState(output);
    if (target <= 0) return output.clear();
    wasmScanU8Lt(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      Math.min(target, 2 ** this.bitWidth),
    );
    return output;
  }

  /** Selects valid values in the half-open interval `[minimum, maximum)`. */
  scanBetween(minimum: number, maximum: number, output: SelectionMask): SelectionMask {
    const min = validatePredicate(minimum);
    const max = validatePredicate(maximum);
    const mask = this.#outputState(output);
    const limit = 2 ** this.bitWidth;
    if (min >= max || max <= 0 || min >= limit) return output.clear();
    wasmScanU8Between(
      this.#planes.pointer,
      this.#validity.pointer,
      mask.allocation.pointer,
      this.#wordCount,
      this.bitWidth,
      Math.max(0, min),
      Math.min(limit, max),
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

  #outputState(output: SelectionMask): MaskState {
    this.#assertAlive();
    const state = maskState(output);
    if (state.length !== this.length) throw new RangeError("mask and column lengths must match");
    return state;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitSlicedU8Column has been disposed");
  }
}

type AdaptiveColumnPage = I32Page | U32Page;

function gatherAdaptivePages(
  pages: readonly AdaptiveColumnPage[],
  mask: MaskState,
  output: Int32Array | Uint32Array,
): number {
  const count = wasmMaskCount(mask.allocation.pointer, mask.wordCount);
  if (output.length < count) {
    throw new RangeError("output must be large enough for all selected values");
  }
  if (count === 0) return 0;
  const scratch = allocator.allocate(count * 4);
  try {
    let written = 0;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const page = pages[pageIndex]!;
      const pageMask = pageOutputPointer(mask, pageIndex);
      const pageOutput = scratch.pointer + written * 4;
      if (page.encoding === AdaptiveI32Encoding.Constant) {
        written += wasmGatherI32Constant(pageMask, page.length, page.min, pageOutput);
      } else if (page.encoding === AdaptiveI32Encoding.Raw) {
        written += wasmGatherI32Raw(
          page.allocation.pointer,
          pageMask,
          page.length,
          pageOutput,
        );
      } else {
        written += wasmGatherI32For(
          page.allocation.pointer,
          pageMask,
          page.length,
          page.bitWidth,
          page.min,
          pageOutput,
        );
      }
    }
    if (written !== count) throw new Error("column gather count mismatch");
    if (output instanceof Int32Array) {
      output.set(new Int32Array(memory.buffer, scratch.pointer, written), 0);
    } else {
      output.set(new Uint32Array(memory.buffer, scratch.pointer, written), 0);
    }
    return written;
  } finally {
    allocator.release(scratch);
  }
}

function serializeAdaptivePages(
  kind: typeof SnapshotKind.AdaptiveI32Column | typeof SnapshotKind.AdaptiveU32Column,
  length: number,
  pages: readonly AdaptiveColumnPage[],
): Uint8Array {
  const metadata = new Uint32Array(pages.length * 6);
  let payloadBytes = 0;
  for (const page of pages) payloadBytes += adaptivePagePayloadBytes(page);
  const payload = new Uint8Array(payloadBytes);
  let payloadOffset = 0;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const base = index * 6;
    const bytes = adaptivePagePayloadBytes(page);
    metadata[base] = page.length | (adaptiveEncodingCode(page.encoding) << 16) |
      (page.bitWidth << 24);
    metadata[base + 1] = page.min >>> 0;
    metadata[base + 2] = page.max >>> 0;
    metadata[base + 3] = page.packedWords;
    metadata[base + 4] = payloadOffset;
    metadata[base + 5] = bytes;
    if (bytes !== 0) {
      payload.set(
        new Uint8Array(memory.buffer, page.allocation.pointer, bytes),
        payloadOffset,
      );
    }
    payloadOffset += bytes;
  }
  return encodeSnapshot(
    kind,
    [length, pages.length],
    [new Uint8Array(metadata.buffer), payload],
  );
}

function restoreI32Pages(
  length: number,
  pageCount: number,
  metadataPayload: Uint8Array,
  storage: Uint8Array,
): I32Page[] {
  return restoreAdaptivePages(length, pageCount, metadataPayload, storage, true);
}

function restoreU32Pages(
  length: number,
  pageCount: number,
  metadataPayload: Uint8Array,
  storage: Uint8Array,
): U32Page[] {
  return restoreAdaptivePages(length, pageCount, metadataPayload, storage, false);
}

function restoreAdaptivePages(
  length: number,
  pageCount: number,
  metadataPayload: Uint8Array,
  storage: Uint8Array,
  signed: boolean,
): I32Page[] {
  expectPayloadBytes(metadataPayload, pageCount * 24, "adaptive page metadata");
  const metadata = uint32Payload(metadataPayload, "adaptive page metadata");
  const pages: I32Page[] = [];
  let expectedOffset = 0;
  try {
    for (let index = 0; index < pageCount; index++) {
      const base = index * 6;
      const header = metadata[base]!;
      const pageLength = header & 0xffff;
      const encoding = adaptiveEncodingFromCode((header >>> 16) & 0xff);
      const bitWidth = header >>> 24;
      const minimum = signed ? metadata[base + 1]! | 0 : metadata[base + 1]!;
      const maximum = signed ? metadata[base + 2]! | 0 : metadata[base + 2]!;
      const packedWords = metadata[base + 3]!;
      const payloadOffset = metadata[base + 4]!;
      const payloadBytes = metadata[base + 5]!;
      const expectedLength = Math.min(PAGE_SIZE, length - index * PAGE_SIZE);
      if (pageLength !== expectedLength) throw invalidSnapshot("invalid adaptive page length");
      if (payloadOffset !== expectedOffset || payloadBytes > storage.byteLength - payloadOffset) {
        throw invalidSnapshot("invalid adaptive page payload range");
      }
      validateAdaptivePageSnapshot(
        pageLength,
        minimum,
        maximum,
        encoding,
        bitWidth,
        packedWords,
        storage.subarray(payloadOffset, payloadOffset + payloadBytes),
        signed,
      );
      const allocation = allocator.allocate(payloadBytes);
      try {
        new Uint8Array(memory.buffer, allocation.pointer, payloadBytes).set(
          storage.subarray(payloadOffset, payloadOffset + payloadBytes),
        );
      } catch (error) {
        allocator.release(allocation);
        throw error;
      }
      pages.push({
        length: pageLength,
        min: minimum,
        max: maximum,
        encoding,
        bitWidth,
        packedWords,
        allocation,
      });
      expectedOffset += payloadBytes;
    }
    if (expectedOffset !== storage.byteLength) {
      throw invalidSnapshot("adaptive payload has trailing bytes");
    }
    return pages;
  } catch (error) {
    for (const page of pages) allocator.release(page.allocation);
    throw error;
  }
}

function validateColumnSnapshotShape(length: number, pageCount: number): void {
  if (length > 0x3fff_ffff || pageCount !== Math.ceil(length / PAGE_SIZE)) {
    throw invalidSnapshot("invalid adaptive column shape");
  }
}

function validateAdaptivePageSnapshot(
  length: number,
  minimum: number,
  maximum: number,
  encoding: AdaptiveI32Encoding,
  bitWidth: number,
  packedWords: number,
  payload: Uint8Array,
  signed: boolean,
): void {
  if (minimum > maximum) throw invalidSnapshot("inverted adaptive ZoneMap");
  if (encoding === AdaptiveI32Encoding.Constant) {
    if (minimum !== maximum || bitWidth !== 0 || packedWords !== 0 || payload.byteLength !== 0) {
      throw invalidSnapshot("invalid constant adaptive page");
    }
    return;
  }
  if (encoding === AdaptiveI32Encoding.FrameOfReference) {
    const range = maximum - minimum;
    const expectedWidth = range === 0 ? 0 : 32 - Math.clz32(range);
    const expectedWords = Math.ceil(length * bitWidth / 32);
    if (
      bitWidth < 1 || bitWidth > 16 || bitWidth !== expectedWidth ||
      packedWords !== expectedWords || payload.byteLength !== expectedWords * 4
    ) throw invalidSnapshot("invalid FOR adaptive page");
    const words = uint32Payload(payload, "adaptive FOR payload");
    let observedMinimum = Number.POSITIVE_INFINITY;
    let observedMaximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < length; index++) {
      const value = minimum + packedAt(words, bitWidth, index);
      if (value < observedMinimum) observedMinimum = value;
      if (value > observedMaximum) observedMaximum = value;
    }
    const usedBits = length * bitWidth;
    if ((usedBits & 31) !== 0 && (words[words.length - 1]! >>> (usedBits & 31)) !== 0) {
      throw invalidSnapshot("non-zero FOR padding");
    }
    if (observedMinimum !== minimum || observedMaximum !== maximum) {
      throw invalidSnapshot("FOR payload does not match ZoneMap");
    }
    return;
  }
  if (bitWidth !== 32 || packedWords !== 0 || payload.byteLength !== length * 4) {
    throw invalidSnapshot("invalid raw adaptive page");
  }
  const words = uint32Payload(payload, "adaptive raw payload");
  let observedMinimum = signed ? words[0]! | 0 : words[0]!;
  let observedMaximum = observedMinimum;
  for (let index = 1; index < words.length; index++) {
    const value = signed ? words[index]! | 0 : words[index]!;
    if (value < observedMinimum) observedMinimum = value;
    if (value > observedMaximum) observedMaximum = value;
  }
  if (observedMinimum !== minimum || observedMaximum !== maximum) {
    throw invalidSnapshot("raw payload does not match ZoneMap");
  }
}

function validateBitSlicedSnapshot(
  length: number,
  bitWidth: number,
  wordCount: number,
  planes: Uint32Array,
  validity: Uint32Array,
): void {
  const logicalWords = Math.ceil(length / 32);
  const tailBits = length & 31;
  const tailMask = tailBits === 0 ? 0xffff_ffff : 0xffff_ffff >>> (32 - tailBits);
  for (let word = 0; word < wordCount; word++) {
    const allowed = word < logicalWords ? word === logicalWords - 1 ? tailMask : 0xffff_ffff : 0;
    const valid = validity[word]!;
    if ((valid & ~allowed) !== 0) throw invalidSnapshot("set validity bits in padding");
    for (let bit = 0; bit < bitWidth; bit++) {
      const plane = planes[bit * wordCount + word]!;
      if ((plane & ~allowed) !== 0 || (plane & ~valid) !== 0) {
        throw invalidSnapshot("invalid bit-sliced plane bits");
      }
    }
  }
}

function adaptivePagePayloadBytes(page: AdaptiveColumnPage): number {
  if (page.encoding === AdaptiveI32Encoding.Constant) return 0;
  if (page.encoding === AdaptiveI32Encoding.Raw) return page.length * 4;
  return page.packedWords * 4;
}

function adaptiveEncodingCode(encoding: AdaptiveI32Encoding): number {
  if (encoding === AdaptiveI32Encoding.Constant) return 0;
  if (encoding === AdaptiveI32Encoding.FrameOfReference) return 1;
  return 2;
}

function adaptiveEncodingFromCode(code: number): AdaptiveI32Encoding {
  if (code === 0) return AdaptiveI32Encoding.Constant;
  if (code === 1) return AdaptiveI32Encoding.FrameOfReference;
  if (code === 2) return AdaptiveI32Encoding.Raw;
  throw invalidSnapshot("unknown adaptive page encoding");
}

function createI32Page(values: Int32Array): I32Page {
  let minimum = values[0] ?? 0;
  let maximum = minimum;
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const range = maximum - minimum;
  if (values.length === 0 || range === 0) {
    return {
      length: values.length,
      min: minimum,
      max: maximum,
      encoding: AdaptiveI32Encoding.Constant,
      bitWidth: 0,
      packedWords: 0,
      allocation: allocator.allocate(0),
    };
  }
  const bitWidth = 32 - Math.clz32(range);
  if (bitWidth <= 16) {
    const packed = packFrameOfReference(values, minimum, bitWidth);
    const allocation = allocator.allocate(packed.byteLength);
    new Uint32Array(memory.buffer, allocation.pointer, packed.length).set(packed);
    return {
      length: values.length,
      min: minimum,
      max: maximum,
      encoding: AdaptiveI32Encoding.FrameOfReference,
      bitWidth,
      packedWords: packed.length,
      allocation,
    };
  }
  const allocation = allocator.allocate(values.length * 4);
  new Int32Array(memory.buffer, allocation.pointer, values.length).set(values);
  return {
    length: values.length,
    min: minimum,
    max: maximum,
    encoding: AdaptiveI32Encoding.Raw,
    bitWidth: 32,
    packedWords: 0,
    allocation,
  };
}

function createU32Page(values: Uint32Array): U32Page {
  let minimum = values[0] ?? 0;
  let maximum = minimum;
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const range = maximum - minimum;
  if (values.length === 0 || range === 0) {
    return {
      length: values.length,
      min: minimum,
      max: maximum,
      encoding: AdaptiveU32Encoding.Constant,
      bitWidth: 0,
      packedWords: 0,
      allocation: allocator.allocate(0),
    };
  }
  const bitWidth = 32 - Math.clz32(range);
  if (bitWidth <= 16) {
    const packed = packFrameOfReference(values, minimum, bitWidth);
    const allocation = allocator.allocate(packed.byteLength);
    new Uint32Array(memory.buffer, allocation.pointer, packed.length).set(packed);
    return {
      length: values.length,
      min: minimum,
      max: maximum,
      encoding: AdaptiveU32Encoding.FrameOfReference,
      bitWidth,
      packedWords: packed.length,
      allocation,
    };
  }
  const allocation = allocator.allocate(values.length * 4);
  new Uint32Array(memory.buffer, allocation.pointer, values.length).set(values);
  return {
    length: values.length,
    min: minimum,
    max: maximum,
    encoding: AdaptiveU32Encoding.Raw,
    bitWidth: 32,
    packedWords: 0,
    allocation,
  };
}

function packFrameOfReference(
  values: ArrayLike<number>,
  base: number,
  bitWidth: number,
): Uint32Array {
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

function maskState(mask: SelectionMask): MaskState {
  const state = maskStates.get(mask);
  if (state === undefined || !state.alive) throw new Error("SelectionMask has been disposed");
  return state;
}

function compatibleMasks(left: SelectionMask, right: SelectionMask): [MaskState, MaskState] {
  const leftState = maskState(left);
  const rightState = maskState(right);
  if (leftState.length !== rightState.length) throw new RangeError("mask lengths must match");
  return [leftState, rightState];
}

function maskWords(state: MaskState): Uint32Array {
  return new Uint32Array(memory.buffer, state.allocation.pointer, state.wordCount);
}

function setPageFull(state: MaskState, pageIndex: number, length: number): void {
  const words = maskWords(state);
  const firstWord = pageIndex * WORDS_PER_PAGE;
  const pageWords = Math.ceil(length / 32);
  words.fill(0xffff_ffff, firstWord, firstWord + pageWords);
  if ((length & 31) !== 0) {
    words[firstWord + pageWords - 1] = (2 ** (length & 31) - 1) >>> 0;
  }
}

function invertPage(state: MaskState, pageIndex: number, length: number): void {
  const words = maskWords(state);
  const firstWord = pageIndex * WORDS_PER_PAGE;
  const pageWords = Math.ceil(length / 32);
  for (let word = 0; word < pageWords; word++) {
    words[firstWord + word] = (~words[firstWord + word]!) >>> 0;
  }
  if ((length & 31) !== 0) {
    words[firstWord + pageWords - 1] =
      (words[firstWord + pageWords - 1]! & (2 ** (length & 31) - 1)) >>> 0;
  }
}

function scanI32PageLt(page: I32Page, outputPointer: number, value: number): void {
  if (page.encoding === AdaptiveI32Encoding.Raw) {
    wasmScanI32LtRaw(page.allocation.pointer, outputPointer, page.length, value);
  } else {
    wasmScanI32LtFor(
      page.allocation.pointer,
      outputPointer,
      page.length,
      page.bitWidth,
      page.min,
      value,
    );
  }
}

function scanU32PageLt(page: U32Page, outputPointer: number, value: number): void {
  if (page.encoding === AdaptiveU32Encoding.Raw) {
    wasmScanU32LtRaw(page.allocation.pointer, outputPointer, page.length, value);
  } else {
    wasmScanU32LtFor(
      page.allocation.pointer,
      outputPointer,
      page.length,
      page.bitWidth,
      page.min,
      value,
    );
  }
}

function pageOutputPointer(state: MaskState, pageIndex: number): number {
  return state.allocation.pointer + pageIndex * WORDS_PER_PAGE * 4;
}

function trimMaskTail(state: MaskState): void {
  const words = maskWords(state);
  for (let word = state.logicalWords; word < state.wordCount; word++) words[word] = 0;
  if (state.logicalWords > 0 && (state.length & 31) !== 0) {
    words[state.logicalWords - 1] =
      (words[state.logicalWords - 1]! & (2 ** (state.length & 31) - 1)) >>> 0;
  }
}

function paddedWordCount(length: number): number {
  return ((Math.ceil(length / 32) + 3) >>> 2) << 2;
}

function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0x3fff_ffff) {
    throw new RangeError("length must be a non-negative Wasm-addressable integer");
  }
}

function validateI32(value: number): number {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError("value must be a signed 32-bit integer");
  }
  return value;
}

function validateU32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError("column values must be unsigned 32-bit integers");
  }
  return value;
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
