import { instantiateSignalKernel, type SignalKernel } from "./signal_kernel.ts";

const WASM_PAGE_BYTES = 65_536;

export type DispatchStrategy = "auto" | "scalar" | "simd";

export interface PackedSignalGraphOptions {
  readonly effectCount: number;
  readonly subscribersBySignal: readonly Iterable<number>[];
  readonly wasm?: boolean;
}

interface Layout {
  readonly signalIds: number;
  readonly output: number;
  readonly byteLength: number;
}

/**
 * Data-oriented signal fan-out index.
 *
 * High-fan-out signals own dense rows over effect IDs. Low-fan-out signals remain sparse so deep
 * derived graphs do not pay a signal-by-effect matrix cost.
 */
export class PackedSignalGraph {
  readonly effectCount: number;
  readonly signalCount: number;
  lastStrategy: Exclude<DispatchStrategy, "auto"> | null = null;
  readonly #subscribers: readonly Uint32Array[];
  readonly #denseRows: Int32Array;
  readonly #memory: WebAssembly.Memory;
  readonly #kernels: SignalKernel | null;
  readonly #layout: Layout;
  readonly #scalarMarks: Uint32Array;
  readonly #effectIds: Uint32Array;
  readonly #words: number;
  #effectView: Uint32Array = new Uint32Array(0);
  #scalarGeneration = 0;

  private constructor(
    effectCount: number,
    subscribers: readonly Uint32Array[],
    denseRows: Int32Array,
    memory: WebAssembly.Memory,
    kernels: SignalKernel | null,
    layout: Layout,
  ) {
    this.effectCount = effectCount;
    this.signalCount = subscribers.length;
    this.#words = alignTo(Math.ceil(effectCount / 32), 4);
    this.#subscribers = subscribers;
    this.#denseRows = denseRows;
    this.#memory = memory;
    this.#kernels = kernels;
    this.#layout = layout;
    this.#scalarMarks = new Uint32Array(effectCount);
    this.#effectIds = new Uint32Array(effectCount);
  }

  static async create(options: PackedSignalGraphOptions): Promise<PackedSignalGraph> {
    if (typeof options !== "object" || options === null) throw new TypeError("options required");
    const effectCount = validateCount(options.effectCount, "effectCount");
    if (!Array.isArray(options.subscribersBySignal)) {
      throw new TypeError("subscribersBySignal must be an array");
    }
    const signalCount = options.subscribersBySignal.length;
    const subscribers: Uint32Array[] = [];
    for (let signalId = 0; signalId < signalCount; signalId++) {
      const row: Iterable<number> = options.subscribersBySignal[signalId]!;
      const unique = new Set<number>();
      for (const effectId of row) {
        validateIndex(effectId, effectCount, "subscriber effect ID");
        unique.add(effectId);
      }
      subscribers.push(Uint32Array.from(unique));
    }
    const paddedWords = alignTo(Math.ceil(effectCount / 32), 4);
    const denseRows = new Int32Array(signalCount);
    denseRows.fill(-1);
    let denseSignalCount = 0;
    if (paddedWords > 0) {
      for (let signalId = 0; signalId < signalCount; signalId++) {
        if (subscribers[signalId]!.length >= paddedWords) {
          denseRows[signalId] = denseSignalCount++;
        }
      }
    }
    const layout = createLayout(denseSignalCount, paddedWords);
    const pages = Math.max(1, Math.ceil(layout.byteLength / WASM_PAGE_BYTES));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const matrix = new Uint32Array(memory.buffer, 0, denseSignalCount * paddedWords);
    const graph = new PackedSignalGraph(
      effectCount,
      subscribers,
      denseRows,
      memory,
      options.wasm === false ? null : await instantiateSignalKernel(memory).catch(() => null),
      layout,
    );
    for (let signalId = 0; signalId < signalCount; signalId++) {
      const denseRow = denseRows[signalId]!;
      if (denseRow < 0) continue;
      for (const effectId of subscribers[signalId]!) {
        const wordIndex = denseRow * paddedWords + (effectId >>> 5);
        matrix[wordIndex] = (matrix[wordIndex]! | (1 << (effectId & 31))) >>> 0;
      }
    }
    return graph;
  }

  /** Collects sorted unique effect IDs. A SIMD result is borrowed until the next collection. */
  collect(signalIds: Iterable<number>, strategy: DispatchStrategy = "auto"): Uint32Array {
    return this.#collectSelected(this.#normalizeSignalIds(signalIds), strategy);
  }

  /**
   * Fast path for validated caller-owned signal IDs. Copy the borrowed SIMD result if it must be
   * retained beyond the next collection.
   */
  collectPacked(signalIds: Uint32Array, strategy: DispatchStrategy = "auto"): Uint32Array {
    return this.#collectSelected(signalIds, strategy);
  }

  #collectSelected(signalIds: Uint32Array, strategy: DispatchStrategy): Uint32Array {
    const selected = signalIds;
    const resolved = this.#resolveStrategy(strategy, selected);
    this.lastStrategy = resolved;
    if (resolved === "scalar") return this.#collectScalar(selected);
    this.#collectSimd(selected);
    const count = enumerateBitsInto(this.#output(), this.effectCount, this.#effectIds);
    if (this.#effectView.length !== count) this.#effectView = this.#effectIds.subarray(0, count);
    return this.#effectView;
  }

  strategyFor(signalIds: Iterable<number>): Exclude<DispatchStrategy, "auto"> {
    return this.#strategyForSelected(this.#normalizeSignalIds(signalIds));
  }

  #resolveStrategy(
    strategy: DispatchStrategy,
    signalIds: Uint32Array,
  ): Exclude<DispatchStrategy, "auto"> {
    if (this.#kernels === null || strategy === "scalar") return "scalar";
    if (strategy === "auto" || strategy === "simd") return this.#strategyForSelected(signalIds);
    throw new TypeError(`unknown dispatch strategy: ${strategy}`);
  }

  #strategyForSelected(signalIds: Uint32Array): Exclude<DispatchStrategy, "auto"> {
    if (signalIds.length < 2) return "scalar";
    for (const signalId of signalIds) if (this.#denseRows[signalId]! < 0) return "scalar";
    return "simd";
  }

  #normalizeSignalIds(signalIds: Iterable<number>): Uint32Array {
    if (signalIds === null || signalIds === undefined || signalIds[Symbol.iterator] === undefined) {
      throw new TypeError("signalIds must be iterable");
    }
    const unique = new Set<number>();
    for (const signalId of signalIds) {
      validateIndex(signalId, this.signalCount, "signal ID");
      unique.add(signalId);
    }
    return Uint32Array.from(unique);
  }

  #collectScalar(signalIds: Uint32Array): Uint32Array {
    this.#scalarGeneration = (this.#scalarGeneration + 1) >>> 0;
    if (this.#scalarGeneration === 0) {
      this.#scalarMarks.fill(0);
      this.#scalarGeneration = 1;
    }
    const generation = this.#scalarGeneration;
    const effects: number[] = [];
    for (const signalId of signalIds) {
      for (const effectId of this.#subscribers[signalId]!) {
        if (this.#scalarMarks[effectId] === generation) continue;
        this.#scalarMarks[effectId] = generation;
        effects.push(effectId);
      }
    }
    effects.sort((left, right) => left - right);
    return Uint32Array.from(effects);
  }

  #collectSimd(signalIds: Uint32Array): void {
    const ids = new Uint32Array(
      this.#memory.buffer,
      this.#layout.signalIds,
      signalIds.length,
    );
    for (let index = 0; index < signalIds.length; index++) {
      ids[index] = this.#denseRows[signalIds[index]!]!;
    }
    this.#kernels!.union_subscriber_rows(
      0,
      this.#layout.signalIds,
      signalIds.length,
      this.#words,
      this.#layout.output,
    );
  }

  #output(): Uint32Array {
    return new Uint32Array(this.#memory.buffer, this.#layout.output, this.#words);
  }
}

function createLayout(denseSignalCount: number, paddedWords: number): Layout {
  const signalIds = alignTo(denseSignalCount * paddedWords * 4, 16);
  const output = alignTo(signalIds + denseSignalCount * 4, 16);
  return { signalIds, output, byteLength: output + paddedWords * 4 };
}

function enumerateBitsInto(
  words: Uint32Array,
  capacity: number,
  destination: Uint32Array,
): number {
  let count = 0;
  const logicalWords = Math.ceil(capacity / 32);
  for (let wordIndex = 0; wordIndex < logicalWords; wordIndex++) {
    let word = words[wordIndex]!;
    while (word !== 0) {
      const lowest = word & -word;
      destination[count++] = (wordIndex << 5) + 31 - Math.clz32(lowest);
      word = (word & (word - 1)) >>> 0;
    }
  }
  return count;
}

function validateCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

function validateIndex(value: number, length: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new RangeError(`${name} out of bounds`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
