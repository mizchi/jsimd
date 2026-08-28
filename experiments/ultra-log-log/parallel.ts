import type {
  UltraLogLogWorkerInit,
  UltraLogLogWorkerOperation,
  UltraLogLogWorkerResponse,
} from "./protocol.ts";
import { UltraLogLogWorkspace } from "./workspace.ts";

const MAX_SHARED_BYTES = 0xffff_ffff;

export interface ParallelUltraLogLogOptions {
  readonly precision: number;
  readonly maxValues: number;
  readonly workerCount: number;
}

interface Layout {
  readonly statesOffset: number;
  readonly byteLength: number;
}

interface WorkerControl {
  readonly worker: Worker;
  run(operation: UltraLogLogWorkerOperation): Promise<void>;
}

/** Persistent Worker admission experiment: local ULL ingestion followed by exact SIMD merge. */
export class ParallelUltraLogLogU32 implements AsyncDisposable {
  readonly precision: number;
  readonly registerCount: number;
  readonly maxValues: number;
  readonly workerCount: number;
  readonly byteLength: number;
  readonly #shared: SharedArrayBuffer;
  readonly #mergeWorkspace: UltraLogLogWorkspace;
  readonly #workers: readonly WorkerControl[];
  readonly #layout: Layout;
  #busy = false;
  #disposed = false;

  private constructor(
    options: ParallelUltraLogLogOptions,
    shared: SharedArrayBuffer,
    mergeWorkspace: UltraLogLogWorkspace,
    workers: readonly WorkerControl[],
    layout: Layout,
  ) {
    this.precision = options.precision;
    this.registerCount = 1 << options.precision;
    this.maxValues = options.maxValues;
    this.workerCount = options.workerCount;
    this.byteLength = layout.byteLength + mergeWorkspace.byteLength;
    this.#shared = shared;
    this.#mergeWorkspace = mergeWorkspace;
    this.#workers = workers;
    this.#layout = layout;
  }

  static async create(options: ParallelUltraLogLogOptions): Promise<ParallelUltraLogLogU32> {
    validateOptions(options);
    const registerCount = 1 << options.precision;
    const statesOffset = align64(options.maxValues * Uint32Array.BYTES_PER_ELEMENT);
    const byteLength = statesOffset + registerCount * options.workerCount;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_SHARED_BYTES) {
      throw new RangeError("parallel UltraLogLog shared layout exceeds 32-bit addressing");
    }
    const layout = { statesOffset, byteLength };
    const shared = new SharedArrayBuffer(byteLength);
    const mergeWorkspace = await UltraLogLogWorkspace.create({
      precision: options.precision,
      maxValues: 0,
      shardCapacity: options.workerCount,
    });
    const workers: WorkerControl[] = [];
    const maxWorkerValues = Math.ceil(options.maxValues / options.workerCount);
    try {
      for (let index = 0; index < options.workerCount; index++) {
        workers.push(
          await startWorker({
            type: "init",
            shared,
            valuesOffset: 0,
            statesOffset,
            stateOffset: index * registerCount,
            precision: options.precision,
            maxValues: maxWorkerValues,
          }),
        );
      }
      return new ParallelUltraLogLogU32(options, shared, mergeWorkspace, workers, layout);
    } catch (error) {
      await stopWorkers(workers);
      await mergeWorkspace[Symbol.asyncDispose]();
      throw error;
    }
  }

  async replace(values: Uint32Array, output: Uint8Array): Promise<number> {
    this.#assertIdle();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (values.length > this.maxValues) throw new RangeError("values exceed maxValues");
    if (!(output instanceof Uint8Array) || output.length < this.registerCount) {
      throw new RangeError("output must cover every register");
    }
    this.#busy = true;
    try {
      new Uint32Array(this.#shared, 0, values.length).set(values);
      const rowsPerWorker = Math.ceil(values.length / this.workerCount);
      await Promise.all(
        this.#workers.map((worker, index) => {
          const rowStart = index * rowsPerWorker;
          return worker.run({
            type: "build",
            rowStart,
            rowCount: Math.max(0, Math.min(rowsPerWorker, values.length - rowStart)),
          });
        }),
      );
      for (let index = 0; index < this.workerCount; index++) {
        this.#mergeWorkspace.setShardState(
          index,
          new Uint8Array(
            this.#shared,
            this.#layout.statesOffset + index * this.registerCount,
            this.registerCount,
          ),
        );
      }
      this.#mergeWorkspace.mergeInto(this.workerCount, output);
      return this.#mergeWorkspace.estimate(output);
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose ParallelUltraLogLogU32 while busy");
    this.#disposed = true;
    await stopWorkers(this.#workers);
    await this.#mergeWorkspace[Symbol.asyncDispose]();
    new Uint8Array(this.#shared).fill(0);
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("ParallelUltraLogLogU32 has been disposed");
    if (this.#busy) throw new Error("ParallelUltraLogLogU32 is busy");
  }
}

function validateOptions(options: ParallelUltraLogLogOptions): void {
  if (options === null || typeof options !== "object") throw new TypeError("options required");
  if (!Number.isSafeInteger(options.precision) || options.precision < 3 || options.precision > 20) {
    throw new RangeError("precision must be between 3 and 20");
  }
  if (!Number.isSafeInteger(options.maxValues) || options.maxValues < 0) {
    throw new RangeError("maxValues must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(options.workerCount) || options.workerCount < 2 ||
    options.workerCount > 32
  ) {
    throw new RangeError("workerCount must be between 2 and 32");
  }
}

function align64(value: number): number {
  return Math.ceil(value / 64) * 64;
}

function startWorker(init: UltraLogLogWorkerInit): Promise<WorkerControl> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let ready = false;
  let requestId = 0;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      if (!ready) reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    worker.onmessage = (event: MessageEvent<UltraLogLogWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        ready = true;
        resolve({
          worker,
          run(operation) {
            const current = ++requestId;
            return new Promise<void>((resolveTask, rejectTask) => {
              pending.set(current, { resolve: resolveTask, reject: rejectTask });
              worker.postMessage({ ...operation, requestId: current });
            });
          },
        });
        return;
      }
      const task = message.requestId === undefined ? undefined : pending.get(message.requestId);
      if (message.type === "error") {
        const error = new Error(message.message);
        if (task === undefined) fail(error);
        else {
          pending.delete(message.requestId!);
          task.reject(error);
        }
        return;
      }
      if (task !== undefined) {
        pending.delete(message.requestId);
        task.resolve();
      }
    };
    worker.onerror = (event) => fail(event.error ?? new Error(event.message));
    worker.postMessage(init);
  });
}

async function stopWorkers(workers: readonly WorkerControl[]): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.run({ type: "stop" })));
  for (const worker of workers) worker.worker.terminate();
}
