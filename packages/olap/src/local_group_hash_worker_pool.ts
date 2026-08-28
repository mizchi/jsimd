import type { SharedBuffer } from "@mizchi/jsimd-shared";
import type {
  LocalGroupHashPage,
  LocalGroupHashWorkerInit,
  LocalGroupHashWorkerOperation,
  LocalGroupHashWorkerResponse,
} from "./local_group_hash_protocol.ts";
import type { LocalGroupHashTableU32 } from "./local_group_hash_table.ts";

export interface LocalGroupHashResidentInput {
  readonly filterByteOffset?: number;
  readonly keysByteOffset: number;
  readonly valuesByteOffset: number;
  readonly validitiesByteOffset: number;
  readonly rowCount: number;
  readonly pageRows?: number;
}

export interface LocalGroupHashScanResult {
  readonly pagesScanned: number;
  readonly pagesSkipped: number;
}

interface WorkerControl {
  readonly worker: Worker;
  run(operation: LocalGroupHashWorkerOperation): Promise<LocalGroupHashScanResult>;
}

/** Persistent build/merge Workers over caller-owned tables and SharedBuffer storage. */
export class LocalGroupHashWorkerPool implements AsyncDisposable {
  readonly workerCount: number;
  readonly #controls: readonly WorkerControl[];
  readonly #supportsFilter: boolean;
  #busy = false;
  #disposed = false;

  private constructor(controls: readonly WorkerControl[], supportsFilter: boolean) {
    this.#controls = controls;
    this.workerCount = controls.length;
    this.#supportsFilter = supportsFilter;
  }

  static async create(
    shared: SharedBuffer,
    partials: readonly LocalGroupHashTableU32[],
    outputs: readonly LocalGroupHashTableU32[],
    input: LocalGroupHashResidentInput,
  ): Promise<LocalGroupHashWorkerPool> {
    const workerCount = partials.length;
    if (
      workerCount < 2 || outputs.length !== workerCount ||
      (workerCount & (workerCount - 1)) !== 0
    ) {
      throw new RangeError("partial and output tables require the same power-of-two Worker count");
    }
    validateInput(shared, input);
    const pages = createPages(shared, input);
    const capacity = partials[0]!.capacity;
    if (
      [...partials, ...outputs].some((table) =>
        table.capacity !== capacity || table.byteOffset + table.byteLength > shared.byteLength
      )
    ) throw new RangeError("all local group tables must use one valid capacity and SharedBuffer");

    const shardRows = Math.ceil(input.rowCount / workerCount);
    const sourceOffsets = partials.map((table) => table.byteOffset);
    const controls: WorkerControl[] = [];
    try {
      for (let worker = 0; worker < workerCount; worker++) {
        const rowStart = worker * shardRows;
        controls.push(
          await startWorker({
            type: "init",
            memory: shared.memory,
            partialOffset: partials[worker]!.byteOffset,
            outputOffset: outputs[worker]!.byteOffset,
            sourceOffsets,
            partition: worker,
            partitionCount: workerCount,
            keysOffset: input.keysByteOffset,
            valuesOffset: input.valuesByteOffset,
            validitiesOffset: input.validitiesByteOffset,
            rowStart,
            rowCount: Math.max(0, Math.min(shardRows, input.rowCount - rowStart)),
            filterOffset: input.filterByteOffset ?? null,
            pages: pages.filter((_, page) => page % workerCount === worker),
          }),
        );
      }
      return new LocalGroupHashWorkerPool(controls, input.filterByteOffset !== undefined);
    } catch (error) {
      await stopWorkers(controls);
      throw error;
    }
  }

  async aggregate(): Promise<void> {
    this.#assertIdle();
    this.#busy = true;
    try {
      await Promise.all(this.#controls.map((control) => control.run({ type: "aggregate" })));
      await Promise.all(this.#controls.map((control) => control.run({ type: "merge" })));
    } finally {
      this.#busy = false;
    }
  }

  async aggregateBetween(minimum: number, maximum: number): Promise<LocalGroupHashScanResult> {
    this.#assertIdle();
    if (!this.#supportsFilter) {
      throw new Error("aggregateBetween requires a resident filter column");
    }
    validateInt32(minimum, "minimum");
    validateInt32(maximum, "maximum");
    this.#busy = true;
    try {
      const scans = await Promise.all(
        this.#controls.map((control) =>
          control.run({ type: "aggregateBetween", minimum, maximum })
        ),
      );
      await Promise.all(this.#controls.map((control) => control.run({ type: "merge" })));
      return scans.reduce(
        (total, scan) => ({
          pagesScanned: total.pagesScanned + scan.pagesScanned,
          pagesSkipped: total.pagesSkipped + scan.pagesSkipped,
        }),
        { pagesScanned: 0, pagesSkipped: 0 },
      );
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose LocalGroupHashWorkerPool during aggregation");
    this.#disposed = true;
    await stopWorkers(this.#controls);
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("LocalGroupHashWorkerPool has been disposed");
    if (this.#busy) throw new Error("LocalGroupHashWorkerPool aggregation is already running");
  }
}

function validateInput(shared: SharedBuffer, input: LocalGroupHashResidentInput): void {
  if (!Number.isSafeInteger(input.rowCount) || input.rowCount < 0) {
    throw new RangeError("rowCount must be a non-negative safe integer");
  }
  shared.uint32Array(input.keysByteOffset, input.rowCount);
  shared.int32Array(input.valuesByteOffset, input.rowCount);
  shared.uint8Array(input.validitiesByteOffset, input.rowCount);
  if (input.filterByteOffset !== undefined) {
    shared.int32Array(input.filterByteOffset, input.rowCount);
    positiveInteger(input.pageRows ?? 65_536, "pageRows");
  } else if (input.pageRows !== undefined) {
    throw new RangeError("pageRows requires filterByteOffset");
  }
}

function createPages(
  shared: SharedBuffer,
  input: LocalGroupHashResidentInput,
): LocalGroupHashPage[] {
  if (input.filterByteOffset === undefined) return [];
  const pageRows = positiveInteger(input.pageRows ?? 65_536, "pageRows");
  const filter = shared.int32Array(input.filterByteOffset, input.rowCount);
  const pages: LocalGroupHashPage[] = [];
  for (let rowStart = 0; rowStart < filter.length; rowStart += pageRows) {
    const rowCount = Math.min(pageRows, filter.length - rowStart);
    let minimum = 0x7fff_ffff;
    let maximum = -0x8000_0000;
    for (let row = rowStart; row < rowStart + rowCount; row++) {
      const value = filter[row]!;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    pages.push({ rowStart, rowCount, minimum, maximum });
  }
  return pages;
}

function startWorker(init: LocalGroupHashWorkerInit): Promise<WorkerControl> {
  const worker = new Worker(new URL("./local_group_hash_worker.ts", import.meta.url), {
    type: "module",
  });
  let requestId = 0;
  let ready = false;
  const pending = new Map<
    number,
    { resolve(result: LocalGroupHashScanResult): void; reject(error: Error): void }
  >();
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      if (!ready) reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    worker.onmessage = (event: MessageEvent<LocalGroupHashWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        ready = true;
        resolve({
          worker,
          run(operation) {
            const current = ++requestId;
            return new Promise<LocalGroupHashScanResult>((resolveTask, rejectTask) => {
              pending.set(current, { resolve: resolveTask, reject: rejectTask });
              worker.postMessage({ ...operation, requestId: current });
            });
          },
        });
        return;
      }
      const task = pending.get(message.requestId);
      if (message.type === "error") {
        const error = new Error(message.message);
        if (task === undefined) fail(error);
        else {
          pending.delete(message.requestId);
          task.reject(error);
        }
        return;
      }
      if (task !== undefined) {
        pending.delete(message.requestId);
        task.resolve({
          pagesScanned: message.pagesScanned,
          pagesSkipped: message.pagesSkipped,
        });
      }
    };
    worker.onerror = (event) => fail(new Error(event.message));
    worker.postMessage(init);
  });
}

async function stopWorkers(controls: readonly WorkerControl[]): Promise<void> {
  await Promise.allSettled(controls.map((control) => control.run({ type: "stop" })));
  for (const control of controls) control.worker.terminate();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateInt32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${name} must be an i32`);
  }
}
