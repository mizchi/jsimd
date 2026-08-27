import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
  type SharedWorkerLease,
} from "../../src/shared-buffer/mod.ts";
import { type HybridKernels, instantiateHybridKernels } from "./kernel.ts";
import type {
  HybridWorkerInit,
  HybridWorkerResponse,
  HybridWorkerSearch,
} from "./parallel_protocol.ts";
import { SharedSelectionMask } from "./shared_selection_mask.ts";

const WASM_PAGE_BYTES = 65_536;

export type HybridPlan = "filter-first" | "vector-first";

export interface ParallelHybridVectorIndexOptions {
  readonly workerCount?: number;
  readonly maxK?: number;
}

export interface HybridSearchOptions {
  readonly k: number;
  readonly plan?: HybridPlan;
}

export interface HybridSearchResult {
  readonly ids: Uint32Array;
  readonly distances: Float32Array;
  readonly selectedCount: number;
  readonly plan: HybridPlan;
  readonly rounds: number;
}

interface Shard {
  readonly rowStart: number;
  readonly rowCount: number;
  readonly scratchOffset: number;
  readonly resultOffset: number;
}

interface Layout {
  readonly byteLength: number;
  readonly predicateMaskOffset: number;
  readonly allMaskOffset: number;
  readonly filtersOffset: number;
  readonly vectorsOffset: number;
  readonly queryOffset: number;
  readonly paddedCount: number;
  readonly shards: readonly Shard[];
}

interface WorkerResult {
  readonly ids: readonly number[];
  readonly distances: readonly number[];
  readonly selectedCount: number;
  readonly exhausted: boolean;
}

interface WorkerControl {
  readonly worker: Worker;
  readonly ready: Promise<SharedWorkerLease>;
  readonly stopped: Promise<void>;
  readonly pending: Map<number, { resolve(value: WorkerResult): void; reject(error: Error): void }>;
  lease?: SharedWorkerLease;
}

/** Experimental persistent Worker pool over one immutable PDX64 index. */
export class ParallelHybridVectorIndex implements AsyncDisposable {
  readonly length: number;
  readonly dimensions: number;
  readonly workerCount: number;
  readonly maxK: number;
  readonly #shared: SharedBuffer;
  readonly #layout: Layout;
  readonly #kernels: HybridKernels;
  readonly #predicateMask: SharedSelectionMask;
  readonly #allGeneration: number;
  readonly #workers: WorkerControl[];
  #epoch = 0;
  #queryCount = 0;
  #busy = false;
  #disposed = false;

  private constructor(
    length: number,
    dimensions: number,
    maxK: number,
    shared: SharedBuffer,
    layout: Layout,
    kernels: HybridKernels,
    predicateMask: SharedSelectionMask,
    allGeneration: number,
    workers: WorkerControl[],
  ) {
    this.length = length;
    this.dimensions = dimensions;
    this.workerCount = workers.length;
    this.maxK = maxK;
    this.#shared = shared;
    this.#layout = layout;
    this.#kernels = kernels;
    this.#predicateMask = predicateMask;
    this.#allGeneration = allGeneration;
    this.#workers = workers;
  }

  static async create(
    filters: Int32Array,
    vectors: Float32Array,
    dimensions: number,
    options: ParallelHybridVectorIndexOptions = {},
  ): Promise<ParallelHybridVectorIndex> {
    if (!(filters instanceof Int32Array)) throw new TypeError("filters must be an Int32Array");
    if (!(vectors instanceof Float32Array)) throw new TypeError("vectors must be a Float32Array");
    const width = positiveInteger(dimensions, "dimensions");
    if (filters.length === 0) throw new RangeError("filters must not be empty");
    if (vectors.length !== filters.length * width) {
      throw new RangeError("vectors length must equal filters.length * dimensions");
    }
    const requestedWorkers = positiveInteger(
      options.workerCount ?? Math.min(4, navigator.hardwareConcurrency || 1),
      "workerCount",
    );
    const maxK = positiveInteger(options.maxK ?? 100, "maxK");
    const workerCount = Math.min(requestedWorkers, Math.ceil(filters.length / 64));
    const layout = createLayout(filters.length, width, workerCount);
    const maxWorkers = workerCount + 1;
    const headerBytes = SHARED_BUFFER_CACHE_LINE_BYTES * (1 + maxWorkers);
    const pages = Math.max(1, Math.ceil((headerBytes + layout.byteLength) / WASM_PAGE_BYTES));
    const shared = await SharedBuffer.create({
      initialPages: pages,
      maximumPages: pages,
      maxWorkers,
    });
    const workers: WorkerControl[] = [];
    try {
      const predicateMask = SharedSelectionMask.initialize(
        shared,
        layout.predicateMaskOffset,
        filters.length,
      );
      const allMask = SharedSelectionMask.initialize(shared, layout.allMaskOffset, filters.length);
      let allGeneration = 0;
      {
        using writer = allMask.claimWriter();
        writer.fillAll();
        allGeneration = writer.publish();
      }
      shared.int32Array(layout.filtersOffset, filters.length).set(filters);
      writePdx64(
        float32View(shared, layout.vectorsOffset, layout.paddedCount * width),
        vectors,
        width,
      );
      const kernels = await instantiateHybridKernels(shared.memory);
      for (const shard of layout.shards) {
        workers.push(startWorker({
          type: "init",
          memory: shared.memory,
          vectorsOffset: layout.vectorsOffset,
          queryOffset: layout.queryOffset,
          predicateMaskOffset: layout.predicateMaskOffset,
          allMaskOffset: layout.allMaskOffset,
          scratchOffset: shard.scratchOffset,
          resultOffset: shard.resultOffset,
          rowStart: shard.rowStart,
          rowCount: shard.rowCount,
          dimensions: width,
        }));
      }
      await Promise.all(workers.map((control) => control.ready));
      return new ParallelHybridVectorIndex(
        filters.length,
        width,
        maxK,
        shared,
        layout,
        kernels,
        predicateMask,
        allGeneration,
        workers,
      );
    } catch (error) {
      for (const control of workers) control.worker.terminate();
      shared[Symbol.dispose]();
      throw error;
    }
  }

  get queryCount(): number {
    return this.#queryCount;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async searchBetween(
    query: Float32Array,
    minimum: number,
    maximum: number,
    options: HybridSearchOptions,
  ): Promise<HybridSearchResult> {
    this.#assertIdle();
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query must be a Float32Array matching index dimensions");
    }
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum >= maximum) {
      throw new RangeError("filter bounds must be increasing safe integers");
    }
    const k = positiveInteger(options.k, "k");
    if (k > this.maxK) throw new RangeError("k exceeds the configured maxK");
    const requestedPlan = options.plan ?? "filter-first";
    if (requestedPlan !== "filter-first" && requestedPlan !== "vector-first") {
      throw new RangeError("unknown hybrid search plan");
    }
    this.#busy = true;
    try {
      float32View(this.#shared, this.#layout.queryOffset, this.dimensions).set(query);
      let generation = 0;
      {
        using writer = this.#predicateMask.claimWriter();
        writer.clearAll();
        this.#kernels.scan_i32_between_mask(
          absolute(this.#shared, this.#layout.filtersOffset),
          this.length,
          minimum,
          maximum,
          absolute(this.#shared, writer.dataByteOffset),
        );
        generation = writer.publish();
      }
      const selectedCount = this.#predicateMask.read(generation).countOnes();
      const result = requestedPlan === "filter-first"
        ? await this.#filterFirst(generation, selectedCount, k)
        : await this.#vectorFirst(minimum, maximum, selectedCount, k);
      this.#queryCount++;
      return { ...result, selectedCount, plan: requestedPlan };
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const control of this.#workers) control.worker.postMessage({ type: "stop" });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(this.#workers.map((control) => control.stopped)),
        new Promise<void>((resolve) => timeout = setTimeout(resolve, 100)),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    for (const control of this.#workers) {
      control.worker.terminate();
      if (control.lease && this.#shared.isLeaseTokenActive(control.lease.leaseToken)) {
        this.#shared.reclaimTerminatedWorker(control.lease);
      }
      for (const pending of control.pending.values()) pending.reject(new Error("index disposed"));
      control.pending.clear();
    }
    this.#shared[Symbol.dispose]();
  }

  async #filterFirst(generation: number, selectedCount: number, k: number) {
    const results = await this.#dispatch("predicate", generation, k);
    const merged = mergeWorkerResults(results, k);
    return { ids: merged.ids, distances: merged.distances, rounds: 1, selectedCount };
  }

  async #vectorFirst(minimum: number, maximum: number, selectedCount: number, k: number) {
    let candidateK = Math.min(this.length, Math.max(k, 4));
    let rounds = 0;
    const filters = this.#shared.int32Array(this.#layout.filtersOffset, this.length);
    for (;;) {
      rounds++;
      const results = await this.#dispatch("all", this.#allGeneration, candidateK);
      const candidates = mergeWorkerResults(results, this.length).pairs.filter((pair) => {
        const value = filters[pair.id]!;
        return value >= minimum && value < maximum;
      });
      const result = candidates.slice(0, Math.min(k, candidates.length));
      const kth = result[k - 1];
      const exact = kth !== undefined && results.every((worker) => {
        if (worker.exhausted) return true;
        const last = worker.ids.length - 1;
        return comparePair(kth, { id: worker.ids[last]!, distance: worker.distances[last]! }) <= 0;
      });
      if (exact || results.every((worker) => worker.exhausted)) {
        return {
          ids: Uint32Array.from(result.map((pair) => pair.id)),
          distances: Float32Array.from(result.map((pair) => pair.distance)),
          rounds,
          selectedCount,
        };
      }
      candidateK = Math.min(this.length, candidateK * 2);
    }
  }

  async #dispatch(
    mask: "predicate" | "all",
    generation: number,
    k: number,
  ): Promise<WorkerResult[]> {
    this.#epoch = nextEpoch(this.#epoch);
    const epoch = this.#epoch;
    return await Promise.all(this.#workers.map((control) => {
      const promise = new Promise<WorkerResult>((resolve, reject) => {
        control.pending.set(epoch, { resolve, reject });
      });
      const task: HybridWorkerSearch = { type: "search", epoch, generation, mask, k };
      control.worker.postMessage(task);
      return promise;
    }));
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("ParallelHybridVectorIndex has been disposed");
    if (this.#busy) throw new Error("concurrent queries are not supported");
  }
}

interface Pair {
  readonly id: number;
  readonly distance: number;
}

function mergeWorkerResults(results: readonly WorkerResult[], k: number) {
  const pairs: Pair[] = [];
  for (const result of results) {
    for (let index = 0; index < result.ids.length; index++) {
      pairs.push({ id: result.ids[index]!, distance: result.distances[index]! });
    }
  }
  pairs.sort(comparePair);
  const selected = pairs.slice(0, Math.min(k, pairs.length));
  return {
    ids: Uint32Array.from(selected.map((pair) => pair.id)),
    distances: Float32Array.from(selected.map((pair) => pair.distance)),
    pairs,
  };
}

function comparePair(left: Pair, right: Pair): number {
  return left.distance - right.distance || left.id - right.id;
}

function startWorker(init: HybridWorkerInit): WorkerControl {
  const worker = new Worker(new URL("./parallel_worker.ts", import.meta.url), { type: "module" });
  let resolveReady!: (lease: SharedWorkerLease) => void;
  let rejectReady!: (error: Error) => void;
  let resolveStopped!: () => void;
  const ready = new Promise<SharedWorkerLease>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const stopped = new Promise<void>((resolve) => resolveStopped = resolve);
  const control: WorkerControl = { worker, ready, stopped, pending: new Map() };
  worker.onmessage = (event: MessageEvent<HybridWorkerResponse>) => {
    const message = event.data;
    if (message.type === "ready") {
      control.lease = message.lease;
      resolveReady(message.lease);
    } else if (message.type === "result") {
      const pending = control.pending.get(message.epoch);
      if (pending === undefined) return;
      control.pending.delete(message.epoch);
      pending.resolve(message);
    } else if (message.type === "stopped") {
      resolveStopped();
    } else {
      const error = new Error(message.message);
      rejectReady(error);
      for (const pending of control.pending.values()) pending.reject(error);
      control.pending.clear();
      resolveStopped();
    }
  };
  worker.onerror = (event) => {
    const error = event.error instanceof Error ? event.error : new Error(event.message);
    rejectReady(error);
    for (const pending of control.pending.values()) pending.reject(error);
    control.pending.clear();
    resolveStopped();
  };
  worker.postMessage(init);
  return control;
}

function createLayout(count: number, dimensions: number, workerCount: number): Layout {
  const paddedCount = Math.ceil(count / 64) * 64;
  const predicateMaskOffset = 0;
  const allMaskOffset = alignTo(
    predicateMaskOffset + SharedSelectionMask.byteLengthFor(count),
    64,
  );
  const filtersOffset = alignTo(allMaskOffset + SharedSelectionMask.byteLengthFor(count), 64);
  const vectorsOffset = alignTo(filtersOffset + count * 4, 64);
  const queryOffset = alignTo(vectorsOffset + paddedCount * dimensions * 4, 64);
  let nextOffset = alignTo(queryOffset + dimensions * 4, 64);
  const blocks = paddedCount / 64;
  const shards: Shard[] = [];
  for (let worker = 0; worker < workerCount; worker++) {
    const startBlock = Math.floor(worker * blocks / workerCount);
    const endBlock = Math.floor((worker + 1) * blocks / workerCount);
    const rowStart = startBlock * 64;
    const rowCount = Math.min(count, endBlock * 64) - rowStart;
    const scratchOffset = nextOffset;
    const resultOffset = alignTo(scratchOffset + alignTo(rowCount, 64) * 4, 16);
    nextOffset = alignTo(resultOffset + 16, 64);
    shards.push({ rowStart, rowCount, scratchOffset, resultOffset });
  }
  return {
    byteLength: nextOffset,
    predicateMaskOffset,
    allMaskOffset,
    filtersOffset,
    vectorsOffset,
    queryOffset,
    paddedCount,
    shards,
  };
}

function writePdx64(output: Float32Array, input: Float32Array, dimensions: number): void {
  output.fill(0);
  const count = input.length / dimensions;
  for (let row = 0; row < count; row++) {
    const block = row >>> 6;
    const lane = row & 63;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      output[(block * dimensions + dimension) * 64 + lane] = input[row * dimensions + dimension]!;
    }
  }
}

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, shared.dataOffset + byteOffset, length);
}

function absolute(shared: SharedBuffer, byteOffset: number): number {
  return shared.dataOffset + byteOffset;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function nextEpoch(epoch: number): number {
  return epoch >= 0xffff_fffe ? 1 : epoch + 1;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
