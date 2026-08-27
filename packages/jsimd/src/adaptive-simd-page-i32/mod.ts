import {
  decode_dictionary as wasmDecodeDictionary,
  decode_for as wasmDecodeFor,
  decode_raw as wasmDecodeRaw,
  decode_rle as wasmDecodeRle,
  decode_sparse as wasmDecodeSparse,
  gather_dictionary as wasmGatherDictionary,
  gather_for as wasmGatherFor,
  gather_raw as wasmGatherRaw,
  gather_rle as wasmGatherRle,
  gather_sparse as wasmGatherSparse,
  mask_and as wasmMaskAnd,
  mask_andnot as wasmMaskAndNot,
  mask_count as wasmMaskCount,
  mask_not as wasmMaskNot,
  mask_or as wasmMaskOr,
  memory,
  scan_between_dictionary as wasmScanBetweenDictionary,
  scan_between_for as wasmScanBetweenFor,
  scan_between_raw as wasmScanBetweenRaw,
  scan_between_rle as wasmScanBetweenRle,
  scan_between_sparse as wasmScanBetweenSparse,
  scan_eq_dictionary as wasmScanEqDictionary,
  scan_eq_for as wasmScanEqFor,
  scan_eq_raw as wasmScanEqRaw,
  scan_eq_rle as wasmScanEqRle,
  scan_eq_sparse as wasmScanEqSparse,
  scan_lt_dictionary as wasmScanLtDictionary,
  scan_lt_for as wasmScanLtFor,
  scan_lt_raw as wasmScanLtRaw,
  scan_lt_rle as wasmScanLtRle,
  scan_lt_sparse as wasmScanLtSparse,
  sum_dictionary as wasmSumDictionary,
  sum_for as wasmSumFor,
  sum_raw as wasmSumRaw,
  sum_rle as wasmSumRle,
  sum_sparse as wasmSumSparse,
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
  Dictionary: "dictionary";
  FrameOfReference: "frame-of-reference";
  RunLength: "run-length";
  Sparse: "sparse";
  Raw: "raw";
}> = Object.freeze(
  {
    Constant: "constant",
    Dictionary: "dictionary",
    FrameOfReference: "frame-of-reference",
    RunLength: "run-length",
    Sparse: "sparse",
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
  readonly #runCount: number;
  readonly #dictionaryCardinality: number;
  readonly #dictionaryCodesOffset: number;
  readonly #sparseExceptionCount: number;
  readonly #sparseValuesOffset: number;
  readonly #sparseDefault: number;
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
      this.#runCount = 0;
      this.#dictionaryCardinality = 0;
      this.#dictionaryCodesOffset = 0;
      this.#sparseExceptionCount = 0;
      this.#sparseValuesOffset = 0;
      this.#sparseDefault = minimum;
      this.#allocation = allocator.allocate(0);
      return;
    }

    const bitWidth = Math.ceil(Math.log2(range + 1));
    const runs = packRunLength(values);
    const sparse = packSparse(values, 64);
    const alternativeBytes = bitWidth <= 16
      ? Math.ceil(values.length * bitWidth / 32) * 4
      : values.byteLength;
    const dictionary = values.length + 16 < Math.min(
        runs.byteLength,
        sparse?.encodedBytes ?? Number.POSITIVE_INFINITY,
        alternativeBytes,
      )
      ? packDictionary(values, 16)
      : undefined;
    if (
      sparse !== undefined &&
      sparse.encodedBytes < Math.min(
          runs.byteLength,
          dictionary?.encodedBytes ?? Number.POSITIVE_INFINITY,
          alternativeBytes,
        )
    ) {
      this.encoding = AdaptivePageEncoding.Sparse;
      this.bitWidth = 0;
      this.#packedWords = 0;
      this.#runCount = 0;
      this.#dictionaryCardinality = 0;
      this.#dictionaryCodesOffset = 0;
      this.#sparseExceptionCount = sparse.exceptionCount;
      this.#sparseValuesOffset = sparse.valuesOffset;
      this.#sparseDefault = sparse.defaultValue;
      this.encodedBytes = sparse.encodedBytes;
      const allocation = allocator.allocate(sparse.payload.byteLength);
      try {
        new Uint8Array(memory.buffer, allocation.pointer, sparse.payload.length).set(
          sparse.payload,
        );
      } catch (error) {
        allocator.release(allocation);
        throw error;
      }
      this.#allocation = allocation;
      return;
    }
    if (
      dictionary !== undefined &&
      dictionary.encodedBytes < Math.min(runs.byteLength, alternativeBytes)
    ) {
      this.encoding = AdaptivePageEncoding.Dictionary;
      this.bitWidth = 0;
      this.#packedWords = 0;
      this.#runCount = 0;
      this.#dictionaryCardinality = dictionary.cardinality;
      this.#dictionaryCodesOffset = dictionary.codesOffset;
      this.#sparseExceptionCount = 0;
      this.#sparseValuesOffset = 0;
      this.#sparseDefault = minimum;
      this.encodedBytes = dictionary.encodedBytes;
      const allocation = allocator.allocate(dictionary.payload.byteLength);
      try {
        new Uint8Array(memory.buffer, allocation.pointer, dictionary.payload.length).set(
          dictionary.payload,
        );
      } catch (error) {
        allocator.release(allocation);
        throw error;
      }
      this.#allocation = allocation;
      return;
    }
    if (runs.byteLength < alternativeBytes) {
      this.encoding = AdaptivePageEncoding.RunLength;
      this.bitWidth = 0;
      this.#packedWords = 0;
      this.#runCount = runs.length >>> 1;
      this.#dictionaryCardinality = 0;
      this.#dictionaryCodesOffset = 0;
      this.#sparseExceptionCount = 0;
      this.#sparseValuesOffset = 0;
      this.#sparseDefault = minimum;
      this.encodedBytes = runs.byteLength;
      const allocation = allocator.allocate(runs.byteLength);
      try {
        new Int32Array(memory.buffer, allocation.pointer, runs.length).set(runs);
      } catch (error) {
        allocator.release(allocation);
        throw error;
      }
      this.#allocation = allocation;
      return;
    }
    if (bitWidth <= 16) {
      this.encoding = AdaptivePageEncoding.FrameOfReference;
      this.bitWidth = bitWidth;
      const packed = packFrameOfReference(values, minimum, bitWidth);
      this.#packedWords = packed.length;
      this.#runCount = 0;
      this.#dictionaryCardinality = 0;
      this.#dictionaryCodesOffset = 0;
      this.#sparseExceptionCount = 0;
      this.#sparseValuesOffset = 0;
      this.#sparseDefault = minimum;
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
    this.#runCount = 0;
    this.#dictionaryCardinality = 0;
    this.#dictionaryCodesOffset = 0;
    this.#sparseExceptionCount = 0;
    this.#sparseValuesOffset = 0;
    this.#sparseDefault = minimum;
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
    if (values instanceof Int32Array) {
      return new AdaptiveSimdPageI32(values);
    }
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
    if (this.encoding === AdaptivePageEncoding.Dictionary) {
      const code = new Uint8Array(
        memory.buffer,
        this.#allocation.pointer + this.#dictionaryCodesOffset,
        this.length,
      )[index]!;
      return new Int32Array(
        memory.buffer,
        this.#allocation.pointer,
        this.#dictionaryCardinality,
      )[code]!;
    }
    if (this.encoding === AdaptivePageEncoding.Sparse) {
      const positions = new Uint8Array(
        memory.buffer,
        this.#allocation.pointer,
        this.#sparseExceptionCount,
      );
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (positions[middle]! < index) low = middle + 1;
        else high = middle;
      }
      if (positions[low] !== index) return this.#sparseDefault;
      return new Int32Array(
        memory.buffer,
        this.#allocation.pointer + this.#sparseValuesOffset,
        this.#sparseExceptionCount,
      )[low]!;
    }
    if (this.encoding === AdaptivePageEncoding.RunLength) {
      const runs = new Int32Array(memory.buffer, this.#allocation.pointer, this.#runCount * 2);
      for (let run = 0; run < this.#runCount; run++) {
        if (index < runs[run * 2 + 1]!) return runs[run * 2]!;
      }
      throw new Error("invalid RLE page");
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
      } else if (this.encoding === AdaptivePageEncoding.Dictionary) {
        wasmDecodeDictionary(
          this.#allocation.pointer,
          this.#allocation.pointer + this.#dictionaryCodesOffset,
          scratch.pointer,
          this.length,
        );
      } else if (this.encoding === AdaptivePageEncoding.Sparse) {
        wasmDecodeSparse(
          this.#allocation.pointer,
          this.#allocation.pointer + this.#sparseValuesOffset,
          scratch.pointer,
          this.length,
          this.#sparseExceptionCount,
          this.#sparseDefault,
        );
      } else if (this.encoding === AdaptivePageEncoding.RunLength) {
        wasmDecodeRle(this.#allocation.pointer, scratch.pointer, this.#runCount);
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
      : this.encoding === AdaptivePageEncoding.Dictionary
      ? wasmSumDictionary(this.#allocation.pointer, this.#dictionaryCardinality)
      : this.encoding === AdaptivePageEncoding.Sparse
      ? wasmSumSparse(
        this.#allocation.pointer + this.#sparseValuesOffset,
        this.length,
        this.#sparseExceptionCount,
        this.#sparseDefault,
      )
      : this.encoding === AdaptivePageEncoding.RunLength
      ? wasmSumRle(this.#allocation.pointer, this.#runCount)
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
    } else if (this.encoding === AdaptivePageEncoding.Dictionary) {
      wasmScanEqDictionary(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#dictionaryCodesOffset,
        mask.allocation.pointer,
        this.length,
        this.#dictionaryCardinality,
        target,
      );
    } else if (this.encoding === AdaptivePageEncoding.Sparse) {
      wasmScanEqSparse(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#sparseValuesOffset,
        mask.allocation.pointer,
        this.length,
        this.#sparseExceptionCount,
        this.#sparseDefault,
        target,
      );
    } else if (this.encoding === AdaptivePageEncoding.RunLength) {
      wasmScanEqRle(this.#allocation.pointer, mask.allocation.pointer, this.#runCount, target);
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
    } else if (this.encoding === AdaptivePageEncoding.Dictionary) {
      wasmScanBetweenDictionary(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#dictionaryCodesOffset,
        mask.allocation.pointer,
        this.length,
        this.#dictionaryCardinality,
        lower,
        upper,
      );
    } else if (this.encoding === AdaptivePageEncoding.Sparse) {
      wasmScanBetweenSparse(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#sparseValuesOffset,
        mask.allocation.pointer,
        this.length,
        this.#sparseExceptionCount,
        this.#sparseDefault,
        lower,
        upper,
      );
    } else if (this.encoding === AdaptivePageEncoding.RunLength) {
      wasmScanBetweenRle(
        this.#allocation.pointer,
        mask.allocation.pointer,
        this.#runCount,
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
        : this.encoding === AdaptivePageEncoding.Dictionary
        ? wasmGatherDictionary(
          this.#allocation.pointer,
          this.#allocation.pointer + this.#dictionaryCodesOffset,
          mask.allocation.pointer,
          scratch.pointer,
          this.length,
        )
        : this.encoding === AdaptivePageEncoding.Sparse
        ? wasmGatherSparse(
          this.#allocation.pointer,
          this.#allocation.pointer + this.#sparseValuesOffset,
          mask.allocation.pointer,
          scratch.pointer,
          this.length,
          this.#sparseExceptionCount,
          this.#sparseDefault,
        )
        : this.encoding === AdaptivePageEncoding.RunLength
        ? wasmGatherRle(
          this.#allocation.pointer,
          mask.allocation.pointer,
          scratch.pointer,
          this.#runCount,
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
    } else if (this.encoding === AdaptivePageEncoding.Dictionary) {
      wasmScanLtDictionary(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#dictionaryCodesOffset,
        mask.allocation.pointer,
        this.length,
        this.#dictionaryCardinality,
        value,
      );
    } else if (this.encoding === AdaptivePageEncoding.Sparse) {
      wasmScanLtSparse(
        this.#allocation.pointer,
        this.#allocation.pointer + this.#sparseValuesOffset,
        mask.allocation.pointer,
        this.length,
        this.#sparseExceptionCount,
        this.#sparseDefault,
        value,
      );
    } else if (this.encoding === AdaptivePageEncoding.RunLength) {
      wasmScanLtRle(this.#allocation.pointer, mask.allocation.pointer, this.#runCount, value);
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

interface ColumnMaskState {
  readonly pages: readonly SimdPageMask[];
  readonly length: number;
  readonly pageSize: number;
  alive: boolean;
}

const columnMaskStates = new WeakMap<SimdColumnMask, ColumnMaskState>();

/** A reusable, Wasm-resident selection mask spanning an adaptive column. */
export class SimdColumnMask {
  readonly length: number;
  readonly pageSize: number;
  readonly pageCount: number;

  constructor(length: number, pageSize = MAX_PAGE_LENGTH) {
    validateColumnLength(length);
    validatePageSize(pageSize);
    this.length = length;
    this.pageSize = pageSize;
    this.pageCount = Math.ceil(length / pageSize);
    const pages: SimdPageMask[] = [];
    try {
      for (let offset = 0; offset < length; offset += pageSize) {
        pages.push(new SimdPageMask(Math.min(pageSize, length - offset)));
      }
    } catch (error) {
      for (const page of pages) page.dispose();
      throw error;
    }
    columnMaskStates.set(this, { pages, length, pageSize, alive: true });
  }

  countOnes(): number {
    return columnMaskState(this).pages.reduce((count, page) => count + page.countOnes(), 0);
  }

  has(index: number): boolean {
    const state = columnMaskState(this);
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.length) {
      throw new RangeError("mask index out of bounds");
    }
    const pageIndex = Math.floor(index / state.pageSize);
    return state.pages[pageIndex]!.has(index - pageIndex * state.pageSize);
  }

  clear(): this {
    for (const page of columnMaskState(this).pages) page.clear();
    return this;
  }

  fill(): this {
    for (const page of columnMaskState(this).pages) page.fill();
    return this;
  }

  andAssign(other: SimdColumnMask): this {
    const [left, right] = compatibleColumnMasks(this, other);
    for (let index = 0; index < left.pages.length; index++) {
      left.pages[index]!.andAssign(right.pages[index]!);
    }
    return this;
  }

  orAssign(other: SimdColumnMask): this {
    const [left, right] = compatibleColumnMasks(this, other);
    for (let index = 0; index < left.pages.length; index++) {
      left.pages[index]!.orAssign(right.pages[index]!);
    }
    return this;
  }

  differenceAssign(other: SimdColumnMask): this {
    const [left, right] = compatibleColumnMasks(this, other);
    for (let index = 0; index < left.pages.length; index++) {
      left.pages[index]!.differenceAssign(right.pages[index]!);
    }
    return this;
  }

  invert(): this {
    for (const page of columnMaskState(this).pages) page.invert();
    return this;
  }

  toIndices(): Uint32Array {
    const state = columnMaskState(this);
    const output = new Uint32Array(this.countOnes());
    let written = 0;
    let base = 0;
    for (const page of state.pages) {
      const local = page.toIndices();
      for (const index of local) output[written++] = base + index;
      base += page.length;
    }
    return output;
  }

  dispose(): void {
    const state = columnMaskStates.get(this);
    if (state === undefined || !state.alive) return;
    state.alive = false;
    for (const page of state.pages) page.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export interface AdaptivePageEncodingCounts {
  readonly constant: number;
  readonly dictionary: number;
  readonly frameOfReference: number;
  readonly runLength: number;
  readonly sparse: number;
  readonly raw: number;
}

/**
 * An immutable i32 column split into independently encoded pages.
 *
 * Bulk predicates use each page's min/max as a zone map before entering its
 * SIMD kernel, so pages outside the predicate range require no payload scan.
 */
export class AdaptiveSimdColumnI32 {
  readonly length: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly min: number;
  readonly max: number;
  readonly encodedBytes: number;
  readonly #pages: readonly AdaptiveSimdPageI32[];
  #disposed = false;

  private constructor(
    pages: readonly AdaptiveSimdPageI32[],
    length: number,
    pageSize: number,
  ) {
    this.#pages = pages;
    this.length = length;
    this.pageSize = pageSize;
    this.pageCount = pages.length;
    let minimum = pages[0]?.min ?? 0;
    let maximum = pages[0]?.max ?? 0;
    let encodedBytes = 0;
    for (const page of pages) {
      if (page.min < minimum) minimum = page.min;
      if (page.max > maximum) maximum = page.max;
      encodedBytes += page.encodedBytes;
    }
    this.min = minimum;
    this.max = maximum;
    this.encodedBytes = encodedBytes;
  }

  static from(
    values: ArrayLike<number>,
    pageSize = MAX_PAGE_LENGTH,
  ): AdaptiveSimdColumnI32 {
    validateColumnLength(values.length);
    validatePageSize(pageSize);
    const pages: AdaptiveSimdPageI32[] = [];
    const scratch = new Int32Array(Math.min(pageSize, values.length));
    try {
      for (let offset = 0; offset < values.length; offset += pageSize) {
        const length = Math.min(pageSize, values.length - offset);
        for (let index = 0; index < length; index++) {
          scratch[index] = validateI32(values[offset + index]!);
        }
        pages.push(AdaptiveSimdPageI32.from(scratch.subarray(0, length)));
      }
      return new AdaptiveSimdColumnI32(pages, values.length, pageSize);
    } catch (error) {
      for (const page of pages) page.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get(index: number): number {
    this.#checkIndex(index);
    const pageIndex = Math.floor(index / this.pageSize);
    return this.#pages[pageIndex]!.get(index - pageIndex * this.pageSize);
  }

  decodeInto(output: Int32Array): number {
    this.#assertAlive();
    if (!(output instanceof Int32Array) || output.length < this.length) {
      throw new RangeError("output must be an Int32Array large enough for the column");
    }
    let offset = 0;
    for (const page of this.#pages) {
      page.decodeInto(output.subarray(offset, offset + page.length));
      offset += page.length;
    }
    return this.length;
  }

  toInt32Array(): Int32Array {
    const output = new Int32Array(this.length);
    this.decodeInto(output);
    return output;
  }

  sum(): number {
    this.#assertAlive();
    return this.#pages.reduce((sum, page) => sum + page.sum(), 0);
  }

  encodingCounts(): AdaptivePageEncodingCounts {
    this.#assertAlive();
    let constant = 0;
    let dictionary = 0;
    let frameOfReference = 0;
    let runLength = 0;
    let sparse = 0;
    let raw = 0;
    for (const page of this.#pages) {
      if (page.encoding === AdaptivePageEncoding.Constant) constant++;
      else if (page.encoding === AdaptivePageEncoding.Dictionary) dictionary++;
      else if (page.encoding === AdaptivePageEncoding.FrameOfReference) frameOfReference++;
      else if (page.encoding === AdaptivePageEncoding.RunLength) runLength++;
      else if (page.encoding === AdaptivePageEncoding.Sparse) sparse++;
      else raw++;
    }
    return Object.freeze({ constant, dictionary, frameOfReference, runLength, sparse, raw });
  }

  scanEq(value: number, output: SimdColumnMask): SimdColumnMask {
    const mask = this.#outputState(output);
    for (let index = 0; index < this.#pages.length; index++) {
      this.#pages[index]!.scanEq(value, mask.pages[index]!);
    }
    return output;
  }

  scanLt(value: number, output: SimdColumnMask): SimdColumnMask {
    const mask = this.#outputState(output);
    for (let index = 0; index < this.#pages.length; index++) {
      this.#pages[index]!.scanLt(value, mask.pages[index]!);
    }
    return output;
  }

  /** Selects values in the half-open interval `[minimum, maximum)`. */
  scanBetween(minimum: number, maximum: number, output: SimdColumnMask): SimdColumnMask {
    const mask = this.#outputState(output);
    for (let index = 0; index < this.#pages.length; index++) {
      this.#pages[index]!.scanBetween(minimum, maximum, mask.pages[index]!);
    }
    return output;
  }

  gatherInto(selection: SimdColumnMask, output: Int32Array): number {
    const mask = this.#outputState(selection);
    const count = selection.countOnes();
    if (!(output instanceof Int32Array) || output.length < count) {
      throw new RangeError("output must be an Int32Array large enough for selected values");
    }
    let written = 0;
    for (let index = 0; index < this.#pages.length; index++) {
      written += this.#pages[index]!.gatherInto(
        mask.pages[index]!,
        output.subarray(written),
      );
    }
    return written;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const page of this.#pages) page.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #outputState(mask: SimdColumnMask): ColumnMaskState {
    this.#assertAlive();
    const state = columnMaskState(mask);
    if (state.length !== this.length || state.pageSize !== this.pageSize) {
      throw new RangeError("mask and column shapes must match");
    }
    return state;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("AdaptiveSimdColumnI32 has been disposed");
  }

  #checkIndex(index: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("column index out of bounds");
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

function packRunLength(values: Int32Array): Int32Array {
  const pairs = new Int32Array(values.length * 2);
  let runCount = 0;
  let value = values[0]!;
  for (let index = 1; index <= values.length; index++) {
    if (index < values.length && values[index] === value) continue;
    pairs[runCount * 2] = value;
    pairs[runCount * 2 + 1] = index;
    runCount++;
    if (index < values.length) value = values[index]!;
  }
  return pairs.slice(0, runCount * 2);
}

interface PackedDictionary {
  readonly cardinality: number;
  readonly codesOffset: number;
  readonly encodedBytes: number;
  readonly payload: Uint8Array;
}

interface PackedSparse {
  readonly defaultValue: number;
  readonly exceptionCount: number;
  readonly valuesOffset: number;
  readonly encodedBytes: number;
  readonly payload: Uint8Array;
}

function packSparse(values: Int32Array, maxExceptions: number): PackedSparse | undefined {
  let defaultValue = 0;
  let balance = 0;
  for (const value of values) {
    if (balance === 0) {
      defaultValue = value;
      balance = 1;
    } else if (value === defaultValue) {
      balance++;
    } else {
      balance--;
    }
  }
  let defaultCount = 0;
  for (const value of values) {
    if (value === defaultValue) defaultCount++;
  }
  const exceptionCount = values.length - defaultCount;
  if (
    exceptionCount === 0 || exceptionCount > maxExceptions || exceptionCount * 4 > values.length
  ) {
    return undefined;
  }
  const valuesOffset = (exceptionCount + 3) & ~3;
  const encodedBytes = valuesOffset + exceptionCount * 4;
  const payload = new Uint8Array((encodedBytes + 15) & ~15);
  const positions = payload.subarray(0, exceptionCount);
  const exceptions = new Int32Array(payload.buffer, valuesOffset, exceptionCount);
  let written = 0;
  for (let index = 0; index < values.length; index++) {
    if (values[index] === defaultValue) continue;
    positions[written] = index;
    exceptions[written] = values[index]!;
    written++;
  }
  return { defaultValue, exceptionCount, valuesOffset, encodedBytes, payload };
}

function packDictionary(values: Int32Array, maxCardinality: number): PackedDictionary | undefined {
  const entries: number[] = [];
  for (const value of values) {
    const position = dictionaryLowerBound(entries, value);
    if (entries[position] === value) continue;
    if (entries.length === maxCardinality) return undefined;
    entries.splice(position, 0, value);
  }

  const cardinality = entries.length;
  const codesOffset = cardinality * 8;
  const encodedBytes = codesOffset + values.length;
  const payload = new Uint8Array((encodedBytes + 15) & ~15);
  new Int32Array(payload.buffer, 0, cardinality).set(entries);
  const counts = new Uint32Array(payload.buffer, cardinality * 4, cardinality);
  const codes = payload.subarray(codesOffset, codesOffset + values.length);
  for (let index = 0; index < values.length; index++) {
    const code = dictionaryLowerBound(entries, values[index]!);
    codes[index] = code;
    counts[code] = counts[code]! + 1;
  }
  return { cardinality, codesOffset, encodedBytes, payload };
}

function dictionaryLowerBound(values: ArrayLike<number>, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
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

function columnMaskState(mask: SimdColumnMask): ColumnMaskState {
  const state = columnMaskStates.get(mask);
  if (state === undefined || !state.alive) throw new Error("SimdColumnMask has been disposed");
  return state;
}

function compatibleColumnMasks(
  left: SimdColumnMask,
  right: SimdColumnMask,
): [ColumnMaskState, ColumnMaskState] {
  const leftState = columnMaskState(left);
  const rightState = columnMaskState(right);
  if (leftState.length !== rightState.length || leftState.pageSize !== rightState.pageSize) {
    throw new RangeError("mask shapes must match");
  }
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

function validateColumnLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new RangeError("column length must be an unsigned 32-bit integer");
  }
}

function validatePageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_LENGTH) {
    throw new RangeError(`page size must be between 1 and ${MAX_PAGE_LENGTH}`);
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
