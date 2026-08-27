import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
} from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { type HybridKernels, instantiateHybridKernels } from "./kernel.ts";
import { SharedSelectionMask } from "./shared_selection_mask.ts";

const WASM_PAGE_BYTES = 65_536;
const PDX_BLOCK_ROWS = 64;

export interface PdxBlockSearchResult {
  readonly ids: Uint32Array;
  readonly distances: Float32Array;
  readonly evaluatedBlocks: number;
  readonly prunedBlocks: number;
  readonly evaluatedRows: number;
}

interface Layout {
  readonly byteLength: number;
  readonly maskOffset: number;
  readonly vectorsOffset: number;
  readonly blockMinimumsOffset: number;
  readonly blockMaximumsOffset: number;
  readonly queryOffset: number;
  readonly fullScratchOffset: number;
  readonly blockScratchOffset: number;
  readonly resultOffset: number;
  readonly outputIdsOffset: number;
  readonly outputDistancesOffset: number;
  readonly statsOffset: number;
  readonly paddedCount: number;
  readonly blocks: number;
}

/** Experimental exact PDX64 scan with optional block-bound pruning. */
export class PdxBlockPruningExperiment implements Disposable {
  readonly length: number;
  readonly dimensions: number;
  readonly maxK: number;
  readonly metadataBytes: number;
  readonly #shared: SharedBuffer;
  readonly #kernels: HybridKernels;
  readonly #layout: Layout;
  readonly #maskGeneration: number;
  #disposed = false;

  private constructor(
    length: number,
    dimensions: number,
    maxK: number,
    shared: SharedBuffer,
    kernels: HybridKernels,
    layout: Layout,
    maskGeneration: number,
  ) {
    this.length = length;
    this.dimensions = dimensions;
    this.maxK = maxK;
    this.metadataBytes = layout.blocks * dimensions * 8;
    this.#shared = shared;
    this.#kernels = kernels;
    this.#layout = layout;
    this.#maskGeneration = maskGeneration;
  }

  static async create(
    values: Float32Array,
    dimensions: number,
    options: { readonly maxK?: number } = {},
  ): Promise<PdxBlockPruningExperiment> {
    if (!(values instanceof Float32Array)) throw new TypeError("values must be a Float32Array");
    const width = positiveInteger(dimensions, "dimensions");
    if (values.length === 0 || values.length % width !== 0) {
      throw new RangeError("values must contain complete non-empty vectors");
    }
    assertFinite(values, "values");
    const length = values.length / width;
    const maxK = positiveInteger(options.maxK ?? 10, "maxK");
    const layout = createLayout(length, width, maxK);
    const pages = Math.max(
      1,
      Math.ceil((SHARED_BUFFER_CACHE_LINE_BYTES * 2 + layout.byteLength) / WASM_PAGE_BYTES),
    );
    const shared = await SharedBuffer.create({ initialPages: pages, maximumPages: pages });
    try {
      const mask = SharedSelectionMask.initialize(shared, layout.maskOffset, length);
      let maskGeneration = 0;
      {
        using writer = mask.claimWriter();
        writer.fillAll();
        maskGeneration = writer.publish();
      }
      writePdx64(
        float32View(shared, layout.vectorsOffset, layout.paddedCount * width),
        values,
        width,
      );
      writeBlockBounds(
        values,
        length,
        width,
        float32View(shared, layout.blockMinimumsOffset, layout.blocks * width),
        float32View(shared, layout.blockMaximumsOffset, layout.blocks * width),
      );
      const kernels = await instantiateHybridKernels(shared.memory);
      return new PdxBlockPruningExperiment(
        length,
        width,
        maxK,
        shared,
        kernels,
        layout,
        maskGeneration,
      );
    } catch (error) {
      shared[Symbol.dispose]();
      throw error;
    }
  }

  searchExact(query: Float32Array, k: number): PdxBlockSearchResult {
    this.#prepare(query, k);
    const mask = SharedSelectionMask.attach(this.#shared, this.#layout.maskOffset).read(
      this.#maskGeneration,
    );
    const filled = this.#kernels.masked_squared_l2_topk_pdx64(
      absolute(this.#shared, this.#layout.vectorsOffset),
      absolute(this.#shared, this.#layout.queryOffset),
      this.length,
      this.dimensions,
      absolute(this.#shared, mask.dataByteOffset),
      absolute(this.#shared, this.#layout.fullScratchOffset),
      absolute(this.#shared, this.#layout.resultOffset),
      absolute(this.#shared, this.#layout.outputIdsOffset),
      absolute(this.#shared, this.#layout.outputDistancesOffset),
      k,
    );
    return this.#copyResult(filled, this.#layout.blocks, 0, this.length);
  }

  searchPruned(query: Float32Array, k: number): PdxBlockSearchResult {
    this.#prepare(query, k);
    const mask = SharedSelectionMask.attach(this.#shared, this.#layout.maskOffset).read(
      this.#maskGeneration,
    );
    const filled = this.#kernels.masked_squared_l2_topk_pdx64_pruned(
      absolute(this.#shared, this.#layout.vectorsOffset),
      absolute(this.#shared, this.#layout.blockMinimumsOffset),
      absolute(this.#shared, this.#layout.blockMaximumsOffset),
      absolute(this.#shared, this.#layout.queryOffset),
      this.length,
      this.dimensions,
      absolute(this.#shared, mask.dataByteOffset),
      absolute(this.#shared, this.#layout.blockScratchOffset),
      absolute(this.#shared, this.#layout.outputIdsOffset),
      absolute(this.#shared, this.#layout.outputDistancesOffset),
      k,
      absolute(this.#shared, this.#layout.statsOffset),
    );
    const stats = this.#shared.uint32Array(this.#layout.statsOffset, 3);
    return this.#copyResult(filled, stats[0]!, stats[1]!, stats[2]!);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#shared[Symbol.dispose]();
  }

  #prepare(query: Float32Array, k: number): void {
    if (this.#disposed) throw new Error("PdxBlockPruningExperiment has been disposed");
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query must match index dimensions");
    }
    assertFinite(query, "query");
    const count = positiveInteger(k, "k");
    if (count > this.maxK) throw new RangeError("k exceeds maxK");
    float32View(this.#shared, this.#layout.queryOffset, this.dimensions).set(query);
  }

  #copyResult(
    filled: number,
    evaluatedBlocks: number,
    prunedBlocks: number,
    evaluatedRows: number,
  ): PdxBlockSearchResult {
    return Object.freeze({
      ids: this.#shared.uint32Array(this.#layout.outputIdsOffset, filled).slice(),
      distances: float32View(
        this.#shared,
        this.#layout.outputDistancesOffset,
        filled,
      ).slice(),
      evaluatedBlocks,
      prunedBlocks,
      evaluatedRows,
    });
  }
}

function createLayout(count: number, dimensions: number, maxK: number): Layout {
  const blocks = Math.ceil(count / PDX_BLOCK_ROWS);
  const paddedCount = blocks * PDX_BLOCK_ROWS;
  const maskOffset = 0;
  const vectorsOffset = alignTo(SharedSelectionMask.byteLengthFor(count), 16);
  const blockMinimumsOffset = vectorsOffset + paddedCount * dimensions * 4;
  const blockMaximumsOffset = blockMinimumsOffset + blocks * dimensions * 4;
  const queryOffset = alignTo(blockMaximumsOffset + blocks * dimensions * 4, 16);
  const fullScratchOffset = alignTo(queryOffset + dimensions * 4, 16);
  const blockScratchOffset = alignTo(fullScratchOffset + paddedCount * 4, 16);
  const resultOffset = blockScratchOffset + PDX_BLOCK_ROWS * 4;
  const outputIdsOffset = alignTo(resultOffset + 16, 16);
  const outputDistancesOffset = outputIdsOffset + maxK * 4;
  const statsOffset = alignTo(outputDistancesOffset + maxK * 4, 16);
  return {
    byteLength: statsOffset + 16,
    maskOffset,
    vectorsOffset,
    blockMinimumsOffset,
    blockMaximumsOffset,
    queryOffset,
    fullScratchOffset,
    blockScratchOffset,
    resultOffset,
    outputIdsOffset,
    outputDistancesOffset,
    statsOffset,
    paddedCount,
    blocks,
  };
}

function writePdx64(output: Float32Array, values: Float32Array, dimensions: number): void {
  const count = values.length / dimensions;
  for (let row = 0; row < count; row++) {
    for (let dimension = 0; dimension < dimensions; dimension++) {
      output[((row >>> 6) * dimensions + dimension) * PDX_BLOCK_ROWS + (row & 63)] =
        values[row * dimensions + dimension]!;
    }
  }
}

function writeBlockBounds(
  values: Float32Array,
  count: number,
  dimensions: number,
  minimums: Float32Array,
  maximums: Float32Array,
): void {
  const blocks = Math.ceil(count / PDX_BLOCK_ROWS);
  for (let block = 0; block < blocks; block++) {
    const start = block * PDX_BLOCK_ROWS;
    const end = Math.min(count, start + PDX_BLOCK_ROWS);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let row = start; row < end; row++) {
        const value = values[row * dimensions + dimension]!;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
      minimums[block * dimensions + dimension] = minimum;
      maximums[block * dimensions + dimension] = maximum;
    }
  }
}

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, absolute(shared, byteOffset), length);
}

function absolute(shared: SharedBuffer, byteOffset: number): number {
  return shared.dataOffset + byteOffset;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function assertFinite(values: Float32Array, name: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must contain finite values`);
  }
}
