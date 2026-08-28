import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
  SharedSelectionMask,
} from "@mizchi/jsimd-shared";
import { instantiateSelectionKernels, type SelectionKernels } from "./kernel.ts";

const WASM_PAGE_BYTES = 65_536;
const RESULT_BYTES = 24;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

export interface I32BetweenPredicate {
  readonly column: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface MaskedI32Aggregate {
  readonly count: number;
  readonly sum: bigint;
  readonly min: number;
  readonly max: number;
}

export interface SharedI32Selection {
  readonly generation: number;
  readonly selectedCount: number;
  aggregate(column: number): MaskedI32Aggregate;
  aggregateMany(columns: readonly number[]): readonly MaskedI32Aggregate[];
}

interface Layout {
  readonly byteLength: number;
  readonly maskOffset: number;
  readonly scratchOffset: number;
  readonly columnOffsets: readonly number[];
  readonly resultOffset: number;
}

/** Admission experiment for one reusable shared mask over same-length resident i32 columns. */
export class SharedI32SelectionPipeline implements AsyncDisposable {
  readonly length: number;
  readonly columnCount: number;
  readonly #shared: SharedBuffer;
  readonly #kernels: SelectionKernels;
  readonly #mask: SharedSelectionMask;
  readonly #layout: Layout;
  #disposed = false;

  private constructor(
    length: number,
    columnCount: number,
    shared: SharedBuffer,
    kernels: SelectionKernels,
    mask: SharedSelectionMask,
    layout: Layout,
  ) {
    this.length = length;
    this.columnCount = columnCount;
    this.#shared = shared;
    this.#kernels = kernels;
    this.#mask = mask;
    this.#layout = layout;
  }

  static async create(columns: readonly Int32Array[]): Promise<SharedI32SelectionPipeline> {
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new RangeError("columns must contain at least one Int32Array");
    }
    const length = columns[0] instanceof Int32Array ? columns[0].length : -1;
    if (columns.some((column) => !(column instanceof Int32Array))) {
      throw new TypeError("every column must be an Int32Array");
    }
    if (columns.some((column) => column.length !== length)) {
      throw new RangeError("all columns must have the same length");
    }
    const layout = createLayout(length, columns.length);
    const headerBytes = SHARED_BUFFER_CACHE_LINE_BYTES * 2;
    const pages = Math.max(1, Math.ceil((headerBytes + layout.byteLength) / WASM_PAGE_BYTES));
    const shared = await SharedBuffer.create({
      initialPages: pages,
      maximumPages: pages,
      maxWorkers: 1,
    });
    try {
      const mask = SharedSelectionMask.initialize(shared, layout.maskOffset, length);
      for (let index = 0; index < columns.length; index++) {
        shared.int32Array(layout.columnOffsets[index]!, length).set(columns[index]!);
      }
      const kernels = await instantiateSelectionKernels(shared.memory);
      return new SharedI32SelectionPipeline(
        length,
        columns.length,
        shared,
        kernels,
        mask,
        layout,
      );
    } catch (error) {
      shared[Symbol.dispose]();
      throw error;
    }
  }

  selectBetween(predicates: readonly I32BetweenPredicate[]): SharedI32Selection {
    this.#assertAlive();
    if (!Array.isArray(predicates)) throw new TypeError("predicates must be an array");
    const checked = predicates.map((predicate) => this.#validatePredicate(predicate));
    let generation = 0;
    {
      using writer = this.#mask.claimWriter();
      if (checked.length === 0) {
        writer.fillAll();
      } else {
        writer.clearAll();
        this.#scan(checked[0]!, writer.dataByteOffset);
        for (let index = 1; index < checked.length; index++) {
          this.#shared.uint32Array(this.#layout.scratchOffset, writer.paddedWords).fill(0);
          this.#scan(checked[index]!, this.#layout.scratchOffset);
          this.#kernels.mask_and(
            absolute(this.#shared, writer.dataByteOffset),
            absolute(this.#shared, this.#layout.scratchOffset),
            writer.paddedWords,
          );
        }
      }
      generation = writer.publish();
    }
    const selectedCount = this.#mask.read(generation).countOnes();
    return Object.freeze({
      generation,
      selectedCount,
      aggregate: (column: number) => this.#aggregate(generation, column),
      aggregateMany: (columns: readonly number[]) => {
        if (!Array.isArray(columns)) throw new TypeError("columns must be an array");
        return Object.freeze(columns.map((column) => this.#aggregate(generation, column)));
      },
    });
  }

  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#shared[Symbol.dispose]();
    return Promise.resolve();
  }

  #scan(predicate: I32BetweenPredicate, outputOffset: number): void {
    this.#kernels.scan_i32_between_mask(
      absolute(this.#shared, this.#layout.columnOffsets[predicate.column]!),
      this.length,
      predicate.minimum,
      predicate.maximum,
      absolute(this.#shared, outputOffset),
    );
  }

  #aggregate(generation: number, column: number): MaskedI32Aggregate {
    this.#assertAlive();
    this.#validateColumn(column);
    const view = this.#mask.read(generation);
    this.#kernels.aggregate_i32_mask(
      absolute(this.#shared, this.#layout.columnOffsets[column]!),
      this.length,
      absolute(this.#shared, view.dataByteOffset),
      absolute(this.#shared, this.#layout.resultOffset),
    );
    const result = new DataView(
      this.#shared.memory.buffer,
      absolute(this.#shared, this.#layout.resultOffset),
      RESULT_BYTES,
    );
    return Object.freeze({
      count: result.getUint32(0, true),
      sum: result.getBigInt64(8, true),
      min: result.getInt32(16, true),
      max: result.getInt32(20, true),
    });
  }

  #validatePredicate(predicate: I32BetweenPredicate): I32BetweenPredicate {
    if (typeof predicate !== "object" || predicate === null) {
      throw new TypeError("predicate must be an object");
    }
    this.#validateColumn(predicate.column);
    validateI32(predicate.minimum, "minimum");
    validateI32(predicate.maximum, "maximum");
    return predicate;
  }

  #validateColumn(column: number): void {
    if (!Number.isSafeInteger(column) || column < 0 || column >= this.columnCount) {
      throw new RangeError("column index out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SharedI32SelectionPipeline has been disposed");
  }
}

function createLayout(length: number, columnCount: number): Layout {
  const maskOffset = 0;
  const maskBytes = SharedSelectionMask.byteLengthFor(length);
  const paddedWords = alignTo(Math.ceil(length / 32), 4);
  const scratchOffset = alignTo(maskOffset + maskBytes, 64);
  let nextOffset = alignTo(scratchOffset + paddedWords * 4, 64);
  const columnOffsets: number[] = [];
  for (let column = 0; column < columnCount; column++) {
    columnOffsets.push(nextOffset);
    nextOffset = alignTo(nextOffset + length * 4, 16);
  }
  const resultOffset = alignTo(nextOffset, 16);
  return {
    byteLength: resultOffset + RESULT_BYTES,
    maskOffset,
    scratchOffset,
    columnOffsets: Object.freeze(columnOffsets),
    resultOffset,
  };
}

function absolute(shared: SharedBuffer, relativeOffset: number): number {
  return shared.dataOffset + relativeOffset;
}

function validateI32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
