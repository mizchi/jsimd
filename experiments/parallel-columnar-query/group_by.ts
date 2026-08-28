import {
  SHARED_BUFFER_CACHE_LINE_BYTES,
  SharedBuffer,
  SharedWaitGroup,
  type SharedWorkerLease,
  type SpscProducerU32,
  SpscRingBufferU32,
  VersionedBuffer,
} from "../../packages/jsimd/src/shared-buffer/mod.ts";
import { instantiateQueryKernels, type QueryKernels } from "./kernel.ts";
import { AggregateStateBlock } from "./aggregate_state.ts";
import {
  GROUP_STOP_TASK,
  type GroupQueryWorkerInit,
  type GroupQueryWorkerMessage,
} from "./group_protocol.ts";
import {
  GROUP_PAGE_DESCRIPTOR_WORDS,
  GROUP_QUERY_CANCEL_EPOCH_INDEX,
  GROUP_QUERY_EPOCH_INDEX,
  GROUP_QUERY_GENERATION_INDEX,
  GROUP_QUERY_MAXIMUM_INDEX,
  GROUP_QUERY_MINIMUM_INDEX,
  GROUP_QUERY_NEXT_PAGE_INDEX,
  GROUP_QUERY_WORDS,
  GROUP_RESULT_HEADER_BYTES,
  groupResultSlotBytes,
  readGroupWorkerResult,
  scanAvailableGroupPages,
} from "./group_worker_scan.ts";

const WASM_PAGE_BYTES = 65_536;
const RING_CAPACITY = 2;
const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

export interface GroupByColumns {
  readonly filter: Int32Array;
  readonly values: Int32Array;
  readonly groups: Uint8Array;
}

export interface ParallelI32GroupByU8Options {
  readonly groupCount?: number;
  readonly workerCount?: number;
  readonly pageRows?: number;
}

export interface GroupByAggregate {
  readonly group: number;
  readonly count: number;
  readonly sum: bigint;
  readonly min: number;
  readonly max: number;
}

export interface GroupByResult {
  readonly groups: readonly GroupByAggregate[];
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
  readonly snapshotFilterOffset: number;
  readonly snapshotValuesOffset: number;
  readonly snapshotGroupsOffset: number;
  readonly pageCount: number;
}

interface WorkerControl {
  readonly worker: Worker;
  readonly ready: Promise<SharedWorkerLease>;
  readonly stopped: Promise<void>;
  readonly failure: Promise<Error>;
  lease?: SharedWorkerLease;
}

/** Experimental low-cardinality group-by over one immutable three-column row-group set. */
export class ParallelI32GroupByU8Query implements AsyncDisposable {
  readonly length: number;
  readonly pageRows: number;
  readonly pageCount: number;
  readonly workerCount: number;
  readonly groupCount: number;
  readonly #shared: SharedBuffer;
  readonly #layout: Layout;
  readonly #waitGroup: SharedWaitGroup;
  readonly #kernels: QueryKernels;
  readonly #snapshots: VersionedBuffer;
  readonly #producers: SpscProducerU32[];
  readonly #workers: WorkerControl[];
  #epoch = 0;
  #busy = false;
  #disposed = false;

  private constructor(
    length: number,
    pageRows: number,
    workerCount: number,
    groupCount: number,
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
    this.groupCount = groupCount;
    this.#shared = shared;
    this.#layout = layout;
    this.#waitGroup = waitGroup;
    this.#kernels = kernels;
    this.#snapshots = snapshots;
    this.#producers = producers;
    this.#workers = workers;
  }

  static async create(
    columns: GroupByColumns,
    options: ParallelI32GroupByU8Options = {},
  ): Promise<ParallelI32GroupByU8Query> {
    validateColumns(columns);
    const groupCount = positiveInteger(
      options.groupCount ?? inferGroupCount(columns.groups),
      "groupCount",
    );
    if (groupCount > 256) throw new RangeError("groupCount must be at most 256");
    for (const group of columns.groups) {
      if (group >= groupCount) throw new RangeError("group key must be less than groupCount");
    }
    const workerCount = positiveInteger(
      options.workerCount ?? Math.min(4, navigator.hardwareConcurrency || 1),
      "workerCount",
    );
    if (workerCount > 254) throw new RangeError("workerCount must be at most 254");
    const pageRows = positiveInteger(options.pageRows ?? 65_536, "pageRows");
    const layout = createLayout(columns.filter.length, pageRows, workerCount, groupCount);
    const maxWorkers = workerCount + 1;
    const sharedHeaderBytes = SHARED_BUFFER_CACHE_LINE_BYTES * (1 + maxWorkers);
    const pages = Math.max(1, Math.ceil((sharedHeaderBytes + layout.byteLength) / WASM_PAGE_BYTES));
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
        initializeSnapshot(writer.bytes, layout, columns, pageRows);
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
          groupCount,
        }));
      }
      await Promise.all(workers.map((control) => control.ready));
      return new ParallelI32GroupByU8Query(
        columns.filter.length,
        pageRows,
        workerCount,
        groupCount,
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

  async aggregateBetween(minimum: number, maximum: number): Promise<GroupByResult> {
    this.#assertIdle();
    const [lower, upper] = validateRange(minimum, maximum);
    this.#busy = true;
    try {
      const epoch = this.#publishQuery(lower, upper);
      this.#waitGroup.add(this.workerCount);
      for (const producer of this.#producers) {
        if (!producer.tryPush(epoch)) throw new Error("group worker task queue unexpectedly full");
      }
      await Promise.race([
        this.#waitGroup.waitAsync(),
        Promise.race(this.#workers.map((control) => control.failure)).then((error) => {
          throw error;
        }),
      ]);
      return mergeResults(
        this.#shared,
        this.#kernels,
        this.#layout.resultOffsets,
        this.#layout.coordinatorResultOffset,
        this.groupCount,
        epoch,
      );
    } finally {
      this.#busy = false;
    }
  }

  aggregateBetweenSingleThread(minimum: number, maximum: number): GroupByResult {
    this.#assertIdle();
    const [lower, upper] = validateRange(minimum, maximum);
    const epoch = this.#publishQuery(lower, upper);
    scanAvailableGroupPages(this.#shared, this.#kernels, this.#snapshots, {
      memory: this.#shared.memory,
      ringOffset: 0,
      waitGroupOffset: this.#layout.waitGroupOffset,
      queryOffset: this.#layout.queryOffset,
      snapshotOffset: this.#layout.snapshotOffset,
      snapshotDescriptorOffset: this.#layout.snapshotDescriptorOffset,
      pageCount: this.#layout.pageCount,
      resultOffset: this.#layout.coordinatorResultOffset,
      groupCount: this.groupCount,
    }, epoch);
    return mergeResults(
      this.#shared,
      this.#kernels,
      [this.#layout.coordinatorResultOffset],
      this.#layout.coordinatorResultOffset,
      this.groupCount,
      epoch,
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#waitGroup.count !== 0) await this.#waitGroup.waitAsync();
    await Promise.allSettled(
      this.#producers.map((producer) => producer.pushAsync(GROUP_STOP_TASK)),
    );
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
      if (
        control.lease !== undefined && this.#shared.isLeaseTokenActive(control.lease.leaseToken)
      ) {
        this.#shared.reclaimTerminatedWorker(control.lease);
      }
    }
    for (const producer of this.#producers) producer[Symbol.dispose]();
    this.#shared[Symbol.dispose]();
  }

  #publishQuery(minimum: number, maximum: number): number {
    this.#epoch = nextEpoch(this.#epoch);
    const query = this.#shared.int32Array(this.#layout.queryOffset, GROUP_QUERY_WORDS);
    Atomics.store(query, GROUP_QUERY_MINIMUM_INDEX, minimum);
    Atomics.store(query, GROUP_QUERY_MAXIMUM_INDEX, maximum);
    Atomics.store(query, GROUP_QUERY_NEXT_PAGE_INDEX, 0);
    Atomics.store(query, GROUP_QUERY_CANCEL_EPOCH_INDEX, 0);
    using snapshot = this.#snapshots.acquire();
    Atomics.store(query, GROUP_QUERY_GENERATION_INDEX, snapshot.generation);
    Atomics.store(query, GROUP_QUERY_EPOCH_INDEX, this.#epoch);
    return this.#epoch;
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("ParallelI32GroupByU8Query has been disposed");
    if (this.#busy) throw new Error("concurrent queries are not supported");
  }
}

export function groupByBetweenReference(
  filter: Int32Array,
  values: Int32Array,
  groups: Uint8Array,
  minimum: number,
  maximum: number,
  groupCount = inferGroupCount(groups),
): GroupByResult {
  validateColumns({ filter, values, groups });
  const [lower, upper] = validateRange(minimum, maximum);
  const count = positiveInteger(groupCount, "groupCount");
  if (count > 256) throw new RangeError("groupCount must be at most 256");
  const counts = new Uint32Array(count);
  const sums = Array<bigint>(count).fill(0n);
  const minimums = new Int32Array(count).fill(I32_MAX);
  const maximums = new Int32Array(count).fill(I32_MIN);
  for (let index = 0; index < filter.length; index++) {
    const selected = filter[index]!;
    if (selected < lower || selected >= upper) continue;
    const group = groups[index]!;
    if (group >= count) throw new RangeError("group key must be less than groupCount");
    const value = values[index]!;
    counts[group]++;
    sums[group] = sums[group]! + BigInt(value);
    if (value < minimums[group]!) minimums[group] = value;
    if (value > maximums[group]!) maximums[group] = value;
  }
  return { groups: compactGroups(counts, sums, minimums, maximums) };
}

function initializeSnapshot(
  bytes: Uint8Array,
  layout: Layout,
  columns: GroupByColumns,
  pageRows: number,
): void {
  bytes.fill(0);
  new Int32Array(
    bytes.buffer,
    bytes.byteOffset + layout.snapshotFilterOffset,
    columns.filter.length,
  ).set(columns.filter);
  new Int32Array(
    bytes.buffer,
    bytes.byteOffset + layout.snapshotValuesOffset,
    columns.values.length,
  ).set(columns.values);
  bytes.subarray(
    layout.snapshotGroupsOffset,
    layout.snapshotGroupsOffset + columns.groups.length,
  ).set(columns.groups);
  const descriptors = new Int32Array(
    bytes.buffer,
    bytes.byteOffset + layout.snapshotDescriptorOffset,
    layout.pageCount * GROUP_PAGE_DESCRIPTOR_WORDS,
  );
  for (let page = 0; page < layout.pageCount; page++) {
    const rowStart = page * pageRows;
    const rowCount = Math.min(pageRows, columns.filter.length - rowStart);
    let minimum = columns.filter[rowStart]!;
    let maximum = minimum;
    for (let row = rowStart + 1; row < rowStart + rowCount; row++) {
      const value = columns.filter[row]!;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    const base = page * GROUP_PAGE_DESCRIPTOR_WORDS;
    descriptors[base] = layout.snapshotFilterOffset + rowStart * 4;
    descriptors[base + 1] = layout.snapshotValuesOffset + rowStart * 4;
    descriptors[base + 2] = layout.snapshotGroupsOffset + rowStart;
    descriptors[base + 3] = rowStart;
    descriptors[base + 4] = rowCount;
    descriptors[base + 5] = minimum;
    descriptors[base + 6] = maximum;
  }
}

function createLayout(
  length: number,
  pageRows: number,
  workerCount: number,
  groupCount: number,
): Layout {
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
  const resultSlotBytes = groupResultSlotBytes(groupCount);
  const resultStart = alignTo(queryOffset + SHARED_BUFFER_CACHE_LINE_BYTES, 64);
  const resultOffsets = Array.from(
    { length: workerCount },
    (_, index) => resultStart + index * resultSlotBytes,
  );
  const coordinatorResultOffset = resultStart + workerCount * resultSlotBytes;
  const snapshotOffset = alignTo(coordinatorResultOffset + resultSlotBytes, 64);
  const snapshotDescriptorOffset = 0;
  const snapshotFilterOffset = alignTo(pageCount * GROUP_PAGE_DESCRIPTOR_WORDS * 4, 16);
  const snapshotValuesOffset = alignTo(snapshotFilterOffset + length * 4, 16);
  const snapshotGroupsOffset = alignTo(snapshotValuesOffset + length * 4, 16);
  const snapshotCapacity = Math.max(1, snapshotGroupsOffset + length);
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
    snapshotFilterOffset,
    snapshotValuesOffset,
    snapshotGroupsOffset,
    pageCount,
  };
}

function mergeResults(
  shared: SharedBuffer,
  kernels: QueryKernels,
  resultOffsets: readonly number[],
  coordinatorResultOffset: number,
  groupCount: number,
  epoch: number,
): GroupByResult {
  const output = AggregateStateBlock.attach(
    shared,
    coordinatorResultOffset + GROUP_RESULT_HEADER_BYTES,
    groupCount,
  );
  const reuseCoordinatorState = resultOffsets.length === 1 &&
    resultOffsets[0] === coordinatorResultOffset;
  if (!reuseCoordinatorState) output.reset();
  let pagesScanned = 0;
  let pagesSkipped = 0;
  for (const resultOffset of resultOffsets) {
    const partial = readGroupWorkerResult(shared, resultOffset, groupCount, epoch);
    pagesScanned += partial.pagesScanned;
    pagesSkipped += partial.pagesSkipped;
    if (!reuseCoordinatorState) output.mergeFrom(partial.state, kernels);
  }
  return {
    groups: compactAggregateState(output),
    pagesScanned,
    pagesSkipped,
  };
}

function compactAggregateState(state: AggregateStateBlock): GroupByAggregate[] {
  const output: GroupByAggregate[] = [];
  for (let group = 0; group < state.groupCount; group++) {
    const aggregate = state.at(group);
    if (aggregate.count === 0) continue;
    output.push({
      group,
      count: aggregate.count,
      sum: aggregate.sum,
      min: aggregate.min!,
      max: aggregate.max!,
    });
  }
  return output;
}

function compactGroups(
  counts: Uint32Array,
  sums: readonly bigint[],
  minimums: Int32Array,
  maximums: Int32Array,
): GroupByAggregate[] {
  const output: GroupByAggregate[] = [];
  for (let group = 0; group < counts.length; group++) {
    const count = counts[group]!;
    if (count === 0) continue;
    output.push({
      group,
      count,
      sum: sums[group]!,
      min: minimums[group]!,
      max: maximums[group]!,
    });
  }
  return output;
}

function startWorker(init: GroupQueryWorkerInit): WorkerControl {
  const worker = new Worker(new URL("./group_worker.ts", import.meta.url), { type: "module" });
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
  worker.onmessage = (event: MessageEvent<GroupQueryWorkerMessage>) => {
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

function validateColumns(columns: GroupByColumns): void {
  if (!(columns.filter instanceof Int32Array)) throw new TypeError("filter must be an Int32Array");
  if (!(columns.values instanceof Int32Array)) throw new TypeError("values must be an Int32Array");
  if (!(columns.groups instanceof Uint8Array)) throw new TypeError("groups must be a Uint8Array");
  if (
    columns.filter.length !== columns.values.length ||
    columns.filter.length !== columns.groups.length
  ) {
    throw new RangeError("filter, values, and groups must have the same length");
  }
}

function inferGroupCount(groups: Uint8Array): number {
  let maximum = 0;
  for (const group of groups) if (group > maximum) maximum = group;
  return maximum + 1;
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
