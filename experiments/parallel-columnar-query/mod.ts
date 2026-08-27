import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
  SharedWaitGroup,
  type SharedWorkerLease,
  type SpscProducerU32,
  SpscRingBufferU32,
  VersionedBuffer,
} from "../../src/shared-buffer/mod.ts";
import { instantiateQueryKernels, type QueryKernels } from "./kernel.ts";
import { type QueryWorkerInit, type QueryWorkerMessage, STOP_TASK } from "./protocol.ts";
import {
  PAGE_DESCRIPTOR_WORDS,
  QUERY_CANCEL_EPOCH_INDEX,
  QUERY_EPOCH_INDEX,
  QUERY_GENERATION_INDEX,
  QUERY_MAXIMUM_INDEX,
  QUERY_MINIMUM_INDEX,
  QUERY_NEXT_PAGE_INDEX,
  QUERY_WORDS,
  readWorkerResult,
  RESULT_SLOT_BYTES,
  scanAvailablePages,
} from "./worker_scan.ts";

const WASM_PAGE_BYTES = 65_536;
const RING_CAPACITY = 2;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

export interface ParallelI32QueryOptions {
  readonly workerCount?: number;
  readonly pageRows?: number;
}

export interface ScanAggregate {
  readonly count: number;
  readonly sum: bigint;
  readonly pagesScanned?: number;
  readonly pagesSkipped?: number;
}

interface Layout {
  readonly byteLength: number;
  readonly waitGroupOffset: number;
  readonly ringOffsets: readonly number[];
  readonly queryOffset: number;
  readonly resultOffsets: readonly number[];
  readonly coordinatorResultOffset: number;
  readonly snapshotOffset: number;
  readonly snapshotCapacity: number;
  readonly snapshotDescriptorOffset: number;
  readonly snapshotDatasetOffset: number;
  readonly pageCount: number;
}

interface WorkerControl {
  readonly worker: Worker;
  readonly ready: Promise<SharedWorkerLease>;
  readonly stopped: Promise<void>;
  readonly failure: Promise<Error>;
  lease?: SharedWorkerLease;
}

/**
 * Experimental shared-memory row-group executor.
 *
 * Values are copied once into shared Wasm memory. Long-lived Workers own disjoint page IDs, apply
 * zone-map pruning, run the SIMD kernel, and publish one cache-line-separated partial aggregate.
 */
export class ParallelI32Query implements AsyncDisposable {
  readonly length: number;
  readonly pageRows: number;
  readonly pageCount: number;
  readonly workerCount: number;
  readonly #shared: SharedBuffer;
  readonly #layout: Layout;
  readonly #waitGroup: SharedWaitGroup;
  readonly #kernels: QueryKernels;
  readonly #snapshots: VersionedBuffer;
  #producers: SpscProducerU32[];
  #workers: WorkerControl[];
  #epoch = 0;
  #busy = false;
  #disposed = false;

  private constructor(
    length: number,
    pageRows: number,
    workerCount: number,
    shared: SharedBuffer,
    layout: Layout,
    waitGroup: SharedWaitGroup,
    kernels: QueryKernels,
    snapshots: VersionedBuffer,
    producers: SpscProducerU32[],
    workers: WorkerControl[],
  ) {
    this.length = length;
    this.pageRows = pageRows;
    this.pageCount = layout.pageCount;
    this.workerCount = workerCount;
    this.#shared = shared;
    this.#layout = layout;
    this.#waitGroup = waitGroup;
    this.#kernels = kernels;
    this.#snapshots = snapshots;
    this.#producers = producers;
    this.#workers = workers;
  }

  static async create(
    values: Int32Array,
    options: ParallelI32QueryOptions = {},
  ): Promise<ParallelI32Query> {
    if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
    const workerCount = positiveInteger(
      options.workerCount ?? Math.min(4, navigator.hardwareConcurrency || 1),
      "workerCount",
    );
    if (workerCount > 254) throw new RangeError("workerCount must be at most 254");
    const pageRows = positiveInteger(options.pageRows ?? 65_536, "pageRows");
    const layout = createLayout(values.length, pageRows, workerCount);
    const maxWorkers = workerCount + 1;
    const sharedHeaderBytes = SHARED_BUFFER_CACHE_LINE_BYTES * (1 + maxWorkers);
    const pages = Math.max(
      1,
      Math.ceil((sharedHeaderBytes + layout.byteLength) / WASM_PAGE_BYTES),
    );
    const shared = await SharedBuffer.create({
      initialPages: pages,
      maximumPages: pages,
      maxWorkers,
    });
    const producers: SpscProducerU32[] = [];
    const workers: WorkerControl[] = [];
    try {
      SharedWaitGroup.initialize(shared, layout.waitGroupOffset);
      const snapshots = VersionedBuffer.initialize(
        shared,
        layout.snapshotOffset,
        layout.snapshotCapacity,
      );
      {
        using writer = snapshots.beginWrite();
        initializeSnapshot(writer.bytes, layout, values, pageRows);
        writer.publish();
      }
      const kernels = await instantiateQueryKernels(shared.memory);
      for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
        const ring = SpscRingBufferU32.initialize(
          shared,
          layout.ringOffsets[workerIndex]!,
          RING_CAPACITY,
        );
        producers.push(ring.producer());
        workers.push(startWorker({
          memory: shared.memory,
          ringOffset: layout.ringOffsets[workerIndex]!,
          waitGroupOffset: layout.waitGroupOffset,
          queryOffset: layout.queryOffset,
          snapshotOffset: layout.snapshotOffset,
          snapshotDescriptorOffset: layout.snapshotDescriptorOffset,
          pageCount: layout.pageCount,
          resultOffset: layout.resultOffsets[workerIndex]!,
          workerIndex,
        }));
      }
      await Promise.all(workers.map((control) => control.ready));
      return new ParallelI32Query(
        values.length,
        pageRows,
        workerCount,
        shared,
        layout,
        SharedWaitGroup.attach(shared, layout.waitGroupOffset),
        kernels,
        snapshots,
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

  get generation(): number {
    this.#assertAlive();
    using snapshot = this.#snapshots.acquire();
    return snapshot.generation;
  }

  /** Publishes a complete immutable replacement without changing the shared-memory layout. */
  replace(values: Int32Array): number {
    this.#assertIdle();
    if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
    if (values.length !== this.length) {
      throw new RangeError("replacement length must match the existing column");
    }
    using writer = this.#snapshots.beginWrite();
    initializeSnapshot(writer.bytes, this.#layout, values, this.pageRows);
    return writer.publish();
  }

  /** Requests cancellation of the active generation at the next row-group boundary. */
  cancelCurrent(): boolean {
    if (this.#disposed || !this.#busy) return false;
    const query = this.#shared.int32Array(this.#layout.queryOffset, QUERY_WORDS);
    Atomics.store(query, QUERY_CANCEL_EPOCH_INDEX, this.#epoch);
    return true;
  }

  /** Replaces every Worker and reclaims stale leases while preserving the published snapshot. */
  async restartWorkers(): Promise<void> {
    this.#assertIdle();
    this.#busy = true;
    try {
      await this.#replaceWorkerPool();
    } finally {
      this.#busy = false;
    }
  }

  async scanBetween(minimum: number, maximum: number): Promise<ScanAggregate> {
    this.#assertIdle();
    const [lower, upper] = validateRange(minimum, maximum);
    this.#busy = true;
    try {
      const epoch = this.#publishQuery(lower, upper);
      this.#waitGroup.add(this.workerCount);
      for (const producer of this.#producers) {
        if (!producer.tryPush(epoch)) throw new Error("worker task queue unexpectedly full");
      }
      try {
        await Promise.race([
          this.#waitGroup.waitAsync(),
          Promise.race(this.#workers.map((control) => control.failure)).then((error) => {
            throw error;
          }),
        ]);
      } catch (error) {
        await this.#replaceWorkerPool();
        throw error;
      }
      const result = mergeResults(this.#shared, this.#layout.resultOffsets, epoch);
      const query = this.#shared.int32Array(this.#layout.queryOffset, QUERY_WORDS);
      if ((Atomics.load(query, QUERY_CANCEL_EPOCH_INDEX) >>> 0) === epoch) {
        throw new DOMException("The query was cancelled", "AbortError");
      }
      return result;
    } finally {
      this.#busy = false;
    }
  }

  /** Runs the identical page ABI and SIMD kernel without Worker scheduling. */
  scanBetweenSingleThread(minimum: number, maximum: number): ScanAggregate {
    this.#assertIdle();
    const [lower, upper] = validateRange(minimum, maximum);
    const epoch = this.#publishQuery(lower, upper);
    scanAvailablePages(this.#shared, this.#kernels, this.#snapshots, {
      memory: this.#shared.memory,
      ringOffset: 0,
      waitGroupOffset: this.#layout.waitGroupOffset,
      queryOffset: this.#layout.queryOffset,
      snapshotOffset: this.#layout.snapshotOffset,
      snapshotDescriptorOffset: this.#layout.snapshotDescriptorOffset,
      pageCount: this.#layout.pageCount,
      resultOffset: this.#layout.coordinatorResultOffset,
      workerIndex: 0,
    }, epoch);
    return readWorkerResult(this.#shared, this.#layout.coordinatorResultOffset, epoch);
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
    await this.#stopWorkerPool();
    this.#shared[Symbol.dispose]();
  }

  #publishQuery(minimum: number, maximum: number): number {
    this.#epoch = nextEpoch(this.#epoch);
    const query = this.#shared.int32Array(this.#layout.queryOffset, QUERY_WORDS);
    Atomics.store(query, QUERY_MINIMUM_INDEX, minimum);
    Atomics.store(query, QUERY_MAXIMUM_INDEX, maximum);
    Atomics.store(query, QUERY_NEXT_PAGE_INDEX, 0);
    Atomics.store(query, QUERY_CANCEL_EPOCH_INDEX, 0);
    Atomics.store(query, QUERY_GENERATION_INDEX, this.generation);
    Atomics.store(query, QUERY_EPOCH_INDEX, this.#epoch);
    return this.#epoch;
  }

  async #replaceWorkerPool(): Promise<void> {
    await this.#stopWorkerPool();
    const remaining = this.#waitGroup.count;
    if (remaining !== 0) this.#waitGroup.add(-remaining);

    const producers: SpscProducerU32[] = [];
    const workers: WorkerControl[] = [];
    try {
      for (let workerIndex = 0; workerIndex < this.workerCount; workerIndex++) {
        const ring = SpscRingBufferU32.initialize(
          this.#shared,
          this.#layout.ringOffsets[workerIndex]!,
          RING_CAPACITY,
        );
        producers.push(ring.producer());
        workers.push(startWorker(this.#workerInit(workerIndex)));
      }
      await Promise.all(workers.map((control) => control.ready));
      this.#producers = producers;
      this.#workers = workers;
    } catch (error) {
      for (const worker of workers) worker.worker.terminate();
      for (const producer of producers) producer[Symbol.dispose]();
      throw error;
    }
  }

  async #stopWorkerPool(): Promise<void> {
    const workers = this.#workers;
    const producers = this.#producers;
    this.#workers = [];
    this.#producers = [];
    await Promise.allSettled(producers.map((producer) => producer.pushAsync(STOP_TASK)));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(workers.map((control) => control.stopped)),
        new Promise<void>((resolve) => timeout = setTimeout(resolve, 100)),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    for (const control of workers) {
      control.worker.terminate();
      if (
        control.lease !== undefined && this.#shared.isLeaseTokenActive(control.lease.leaseToken)
      ) {
        this.#shared.reclaimTerminatedWorker(control.lease);
      }
    }
    for (const producer of producers) producer[Symbol.dispose]();
  }

  #workerInit(workerIndex: number): QueryWorkerInit {
    return {
      memory: this.#shared.memory,
      ringOffset: this.#layout.ringOffsets[workerIndex]!,
      waitGroupOffset: this.#layout.waitGroupOffset,
      queryOffset: this.#layout.queryOffset,
      snapshotOffset: this.#layout.snapshotOffset,
      snapshotDescriptorOffset: this.#layout.snapshotDescriptorOffset,
      pageCount: this.#layout.pageCount,
      resultOffset: this.#layout.resultOffsets[workerIndex]!,
      workerIndex,
    };
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("ParallelI32Query has been disposed");
  }

  #assertIdle(): void {
    this.#assertAlive();
    if (this.#busy) throw new Error("concurrent queries are not supported");
  }
}

export function scanBetweenReference(
  values: Int32Array,
  minimum: number,
  maximum: number,
): ScanAggregate {
  if (!(values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
  const [lower, upper] = validateRange(minimum, maximum);
  let count = 0;
  let sum = 0n;
  for (const value of values) {
    if (value >= lower && value < upper) {
      count++;
      sum += BigInt(value);
    }
  }
  return { count, sum };
}

function initializeSnapshot(
  bytes: Uint8Array,
  layout: Layout,
  values: Int32Array,
  pageRows: number,
): void {
  bytes.fill(0);
  new Int32Array(
    bytes.buffer,
    bytes.byteOffset + layout.snapshotDatasetOffset,
    values.length,
  ).set(values);
  const descriptors = new Int32Array(
    bytes.buffer,
    bytes.byteOffset + layout.snapshotDescriptorOffset,
    layout.pageCount * PAGE_DESCRIPTOR_WORDS,
  );
  for (let page = 0; page < layout.pageCount; page++) {
    const rowStart = page * pageRows;
    const rowCount = Math.min(pageRows, values.length - rowStart);
    let minimum = values[rowStart]!;
    let maximum = minimum;
    for (let row = rowStart + 1; row < rowStart + rowCount; row++) {
      const value = values[row]!;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    const base = page * PAGE_DESCRIPTOR_WORDS;
    descriptors[base] = layout.snapshotDatasetOffset + rowStart * 4;
    descriptors[base + 1] = rowStart;
    descriptors[base + 2] = rowCount;
    descriptors[base + 3] = minimum;
    descriptors[base + 4] = maximum;
  }
}

function createLayout(length: number, pageRows: number, workerCount: number): Layout {
  const pageCount = Math.ceil(length / pageRows);
  const waitGroupOffset = 0;
  const ringStride = SpscRingBufferU32.byteLengthFor(RING_CAPACITY);
  const ringOffsets = Array.from(
    { length: workerCount },
    (_, index) => SHARED_BUFFER_CACHE_LINE_BYTES + index * ringStride,
  );
  const queryOffset = alignTo(
    SHARED_BUFFER_CACHE_LINE_BYTES + workerCount * ringStride,
    SHARED_BUFFER_CACHE_LINE_BYTES,
  );
  const resultStart = alignTo(queryOffset + SHARED_BUFFER_CACHE_LINE_BYTES, 64);
  const resultOffsets = Array.from(
    { length: workerCount },
    (_, index) => resultStart + index * RESULT_SLOT_BYTES,
  );
  const coordinatorResultOffset = resultStart + workerCount * RESULT_SLOT_BYTES;
  const snapshotOffset = alignTo(coordinatorResultOffset + RESULT_SLOT_BYTES, 64);
  const snapshotDescriptorOffset = 0;
  const snapshotDatasetOffset = alignTo(pageCount * PAGE_DESCRIPTOR_WORDS * 4, 16);
  const snapshotCapacity = Math.max(1, snapshotDatasetOffset + length * 4);
  return {
    byteLength: snapshotOffset + VersionedBuffer.byteLengthFor(snapshotCapacity),
    waitGroupOffset,
    ringOffsets,
    queryOffset,
    resultOffsets,
    coordinatorResultOffset,
    snapshotOffset,
    snapshotCapacity,
    snapshotDescriptorOffset,
    snapshotDatasetOffset,
    pageCount,
  };
}

function mergeResults(
  shared: SharedBuffer,
  resultOffsets: readonly number[],
  epoch: number,
): ScanAggregate {
  let count = 0;
  let sum = 0n;
  let pagesScanned = 0;
  let pagesSkipped = 0;
  for (const resultOffset of resultOffsets) {
    const result = readWorkerResult(shared, resultOffset, epoch);
    count += result.count;
    sum += result.sum;
    pagesScanned += result.pagesScanned;
    pagesSkipped += result.pagesSkipped;
  }
  return { count, sum, pagesScanned, pagesSkipped };
}

function startWorker(init: QueryWorkerInit): WorkerControl {
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
  const control: WorkerControl = { worker, ready, stopped, failure };
  worker.onmessage = (event: MessageEvent<QueryWorkerMessage>) => {
    if (event.data.phase === "ready") {
      control.lease = event.data.lease;
      resolveReady(event.data.lease);
    } else if (event.data.phase === "stopped") resolveStopped();
    else {
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
  return control;
}

function validateRange(minimum: number, maximum: number): readonly [number, number] {
  return [validateI32(minimum, "minimum"), validateI32(maximum, "maximum")];
}

function validateI32(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < I32_MIN || value > I32_MAX) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nextEpoch(previous: number): number {
  return previous >= 0x7fff_fffe ? 1 : previous + 1;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
