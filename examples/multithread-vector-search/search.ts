import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SHARED_SYNC_BYTE_LENGTH,
  SharedBuffer,
  SharedWaitGroup,
  type SharedWorkerLease,
  type SpscProducerU32,
  SpscRingBufferU32,
} from "../../src/shared-buffer/mod.ts";
import { STOP_TASK, type VectorWorkerInit, type VectorWorkerMessage } from "./protocol.ts";

const WASM_PAGE_BYTES = 65_536;
const RING_CAPACITY = 2;

export interface MultithreadVectorSearchOptions {
  readonly workerCount?: number;
  readonly k?: number;
}

export interface VectorSearchResult {
  readonly ids: Uint32Array;
  readonly distances: Float32Array;
}

interface Layout {
  readonly byteLength: number;
  readonly waitGroupOffset: number;
  readonly ringOffsets: readonly number[];
  readonly datasetOffset: number;
  readonly queryOffset: number;
  readonly resultOffsets: readonly number[];
  readonly resultStride: number;
}

interface WorkerControl {
  readonly worker: Worker;
  readonly ready: Promise<SharedWorkerLease>;
  readonly stopped: Promise<void>;
  readonly failure: Promise<Error>;
}

/**
 * Shards one exact squared-L2 index across Workers.
 *
 * Dataset shards are copied once from shared memory into each Worker's private SIMD index. Queries,
 * task notifications, and top-k candidate results remain in shared memory for repeated searches.
 */
export class MultithreadVectorSearch implements AsyncDisposable {
  readonly length: number;
  readonly dimensions: number;
  readonly workerCount: number;
  readonly k: number;
  readonly #shared: SharedBuffer;
  readonly #layout: Layout;
  readonly #waitGroup: SharedWaitGroup;
  readonly #producers: readonly SpscProducerU32[];
  readonly #workers: readonly WorkerControl[];
  #epoch = 0;
  #busy = false;
  #disposed = false;

  private constructor(
    length: number,
    dimensions: number,
    workerCount: number,
    k: number,
    shared: SharedBuffer,
    layout: Layout,
    waitGroup: SharedWaitGroup,
    producers: readonly SpscProducerU32[],
    workers: readonly WorkerControl[],
  ) {
    this.length = length;
    this.dimensions = dimensions;
    this.workerCount = workerCount;
    this.k = k;
    this.#shared = shared;
    this.#layout = layout;
    this.#waitGroup = waitGroup;
    this.#producers = producers;
    this.#workers = workers;
  }

  static async create(
    values: Float32Array,
    length: number,
    dimensions: number,
    options: MultithreadVectorSearchOptions = {},
  ): Promise<MultithreadVectorSearch> {
    validateShape(values, length, dimensions);
    const workerCount = validatePositiveInteger(
      options.workerCount ?? Math.min(4, navigator.hardwareConcurrency || 1),
      "workerCount",
    );
    if (workerCount > 254) {
      throw new RangeError("workerCount must be at most 254");
    }
    if (workerCount > length) throw new RangeError("workerCount must not exceed vector count");
    const k = validatePositiveInteger(options.k ?? 10, "k");
    if (k > length) throw new RangeError("k must not exceed vector count");
    const layout = createLayout(length, dimensions, workerCount, k);
    const maxWorkers = workerCount + 1;
    const headerBytes = SHARED_BUFFER_CACHE_LINE_BYTES * (1 + maxWorkers);
    const pages = Math.ceil((headerBytes + layout.byteLength) / WASM_PAGE_BYTES);
    const shared = await SharedBuffer.create({
      initialPages: pages,
      maximumPages: pages,
      maxWorkers,
    });
    const producers: SpscProducerU32[] = [];
    const workers: WorkerControl[] = [];
    try {
      float32View(shared, layout.datasetOffset, values.length).set(values);
      const waitGroup = SharedWaitGroup.initialize(shared, layout.waitGroupOffset);
      for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
        const ring = SpscRingBufferU32.initialize(
          shared,
          layout.ringOffsets[workerIndex]!,
          RING_CAPACITY,
        );
        producers.push(ring.producer());
        const rowStart = Math.floor(workerIndex * length / workerCount);
        const rowEnd = Math.floor((workerIndex + 1) * length / workerCount);
        const control = startWorker({
          memory: shared.memory,
          ringOffset: layout.ringOffsets[workerIndex]!,
          waitGroupOffset: layout.waitGroupOffset,
          datasetOffset: layout.datasetOffset,
          queryOffset: layout.queryOffset,
          resultOffset: layout.resultOffsets[workerIndex]!,
          rowStart,
          rowCount: rowEnd - rowStart,
          dimensions,
          k,
        });
        workers.push(control);
      }
      await Promise.all(workers.map((control) => control.ready));
      return new MultithreadVectorSearch(
        length,
        dimensions,
        workerCount,
        k,
        shared,
        layout,
        waitGroup,
        producers,
        workers,
      );
    } catch (error) {
      for (const worker of workers) worker.worker.terminate();
      for (const producer of producers) producer[Symbol.dispose]();
      shared[Symbol.dispose]();
      throw error;
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async search(query: Float32Array): Promise<VectorSearchResult> {
    this.#assertAlive();
    if (this.#busy) throw new Error("concurrent searches are not supported");
    if (!(query instanceof Float32Array) || query.length !== this.dimensions) {
      throw new RangeError("query dimensions must match the index");
    }
    this.#busy = true;
    try {
      float32View(this.#shared, this.#layout.queryOffset, this.dimensions).set(query);
      for (const resultOffset of this.#layout.resultOffsets) {
        Atomics.store(this.#shared.uint32Array(resultOffset, 1), 0, 0);
      }
      this.#waitGroup.add(this.workerCount);
      this.#epoch = nextEpoch(this.#epoch);
      for (const producer of this.#producers) {
        if (!producer.tryPush(this.#epoch)) {
          throw new Error("worker task queue unexpectedly full");
        }
      }
      await Promise.race([
        this.#waitGroup.waitAsync(),
        Promise.race(this.#workers.map((control) => control.failure)).then((error) => {
          throw error;
        }),
      ]);
      return this.#mergeCandidates();
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#waitGroup.count !== 0) {
      await Promise.race([
        this.#waitGroup.waitAsync(),
        Promise.race(this.#workers.map((control) => control.failure)),
      ]);
    }
    for (const producer of this.#producers) producer.tryPush(STOP_TASK);
    await Promise.allSettled(this.#workers.map((control) => control.stopped));
    for (const control of this.#workers) control.worker.terminate();
    for (const producer of this.#producers) producer[Symbol.dispose]();
    this.#shared[Symbol.dispose]();
  }

  #mergeCandidates(): VectorSearchResult {
    const candidates: Array<{ readonly id: number; readonly distance: number }> = [];
    for (const resultOffset of this.#layout.resultOffsets) {
      const header = this.#shared.uint32Array(resultOffset, 1 + this.k);
      const count = Atomics.load(header, 0);
      const distances = float32View(
        this.#shared,
        resultOffset + (1 + this.k) * 4,
        this.k,
      );
      for (let index = 0; index < count; index++) {
        candidates.push({ id: header[1 + index]!, distance: distances[index]! });
      }
    }
    candidates.sort((left, right) => left.distance - right.distance || left.id - right.id);
    const count = Math.min(this.k, candidates.length);
    const ids = new Uint32Array(count);
    const distances = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      ids[index] = candidates[index]!.id;
      distances[index] = candidates[index]!.distance;
    }
    return { ids, distances };
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("MultithreadVectorSearch has been disposed");
  }
}

function startWorker(init: VectorWorkerInit): WorkerControl {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let resolveReady!: (lease: SharedWorkerLease) => void;
  let rejectReady!: (error: Error) => void;
  let resolveStopped!: () => void;
  let resolveFailure!: (error: Error) => void;
  const ready = new Promise<SharedWorkerLease>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const stopped = new Promise<void>((resolve) => resolveStopped = resolve);
  const failure = new Promise<Error>((resolve) => resolveFailure = resolve);
  worker.onmessage = (event: MessageEvent<VectorWorkerMessage>) => {
    if (event.data.phase === "ready") {
      resolveReady({ workerId: event.data.workerId, leaseToken: event.data.leaseToken });
    } else if (event.data.phase === "stopped") {
      resolveStopped();
    } else {
      const error = new Error(event.data.message);
      rejectReady(error);
      resolveFailure(error);
      resolveStopped();
    }
  };
  worker.onerror = (event) => {
    const error = event.error instanceof Error ? event.error : new Error(event.message);
    rejectReady(error);
    resolveFailure(error);
    resolveStopped();
  };
  worker.postMessage(init);
  return { worker, ready, stopped, failure };
}

function createLayout(length: number, dimensions: number, workers: number, k: number): Layout {
  const waitGroupOffset = 0;
  const ringStride = SpscRingBufferU32.byteLengthFor(RING_CAPACITY);
  const ringOffsets = Array.from(
    { length: workers },
    (_, index) => SHARED_SYNC_BYTE_LENGTH + index * ringStride,
  );
  const datasetOffset = alignTo(
    SHARED_SYNC_BYTE_LENGTH + workers * ringStride,
    SHARED_BUFFER_CACHE_LINE_BYTES,
  );
  const queryOffset = alignTo(datasetOffset + length * dimensions * 4, 4);
  const resultStride = alignTo((1 + k + k) * 4, SHARED_BUFFER_CACHE_LINE_BYTES);
  const firstResultOffset = alignTo(
    queryOffset + dimensions * 4,
    SHARED_BUFFER_CACHE_LINE_BYTES,
  );
  const resultOffsets = Array.from(
    { length: workers },
    (_, index) => firstResultOffset + index * resultStride,
  );
  const byteLength = firstResultOffset + workers * resultStride;
  if (!Number.isSafeInteger(byteLength) || byteLength > 0x7fff_ffff) {
    throw new RangeError("shared vector-search layout is too large");
  }
  return {
    byteLength,
    waitGroupOffset,
    ringOffsets,
    datasetOffset,
    queryOffset,
    resultOffsets,
    resultStride,
  };
}

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, shared.dataOffset + byteOffset, length);
}

function nextEpoch(current: number): number {
  const next = (current + 1) >>> 0;
  return next === STOP_TASK ? 0 : next;
}

function validateShape(values: Float32Array, length: number, dimensions: number): void {
  if (!(values instanceof Float32Array)) throw new TypeError("values must be a Float32Array");
  validatePositiveInteger(length, "length");
  validatePositiveInteger(dimensions, "dimensions");
  if (values.length !== length * dimensions) {
    throw new RangeError("Float32 shape does not match values");
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
