import { UltraLogLogU32 } from "./core.ts";
import type {
  UltraLogLogWorkerInit,
  UltraLogLogWorkerOperation,
  UltraLogLogWorkerResponse,
} from "./protocol.ts";

const DEFAULT_WORKER_THRESHOLD = 65_536;
const MAX_SHARED_BYTES = 0xffff_ffff;

export type UltraLogLogExecutionStrategy = "serial" | "workers";

export interface ParallelUltraLogLogOptions {
  readonly precision?: number;
  readonly maxValues: number;
  readonly workerCount: number;
  readonly workerThreshold?: number;
}

interface WorkerControl {
  readonly worker: WorkerLike;
  run(operation: UltraLogLogWorkerOperation): Promise<void>;
}

interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): unknown;
  onmessage?: ((event: MessageEvent<UltraLogLogWorkerResponse>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  on?(event: "message", listener: (message: UltraLogLogWorkerResponse) => void): void;
  on?(event: "error", listener: (error: Error) => void): void;
}

/** Size-aware persistent-Worker cardinality sketch for repeated bulk replacement. */
export class ParallelUltraLogLogU32 implements AsyncDisposable {
  readonly precision: number;
  readonly registerCount: number;
  readonly maxValues: number;
  readonly workerCount: number;
  readonly workerThreshold: number;
  readonly byteLength: number;
  readonly #shared: SharedArrayBuffer;
  readonly #statesOffset: number;
  readonly #result: UltraLogLogU32;
  readonly #workers: readonly WorkerControl[];
  #lastStrategy: UltraLogLogExecutionStrategy | null = null;
  #busy = false;
  #disposed = false;

  private constructor(
    options: Required<ParallelUltraLogLogOptions>,
    shared: SharedArrayBuffer,
    statesOffset: number,
    result: UltraLogLogU32,
    workers: readonly WorkerControl[],
  ) {
    this.precision = options.precision;
    this.registerCount = 1 << options.precision;
    this.maxValues = options.maxValues;
    this.workerCount = options.workerCount;
    this.workerThreshold = options.workerThreshold;
    this.byteLength = shared.byteLength + result.byteLength;
    this.#shared = shared;
    this.#statesOffset = statesOffset;
    this.#result = result;
    this.#workers = workers;
  }

  static async create(rawOptions: ParallelUltraLogLogOptions): Promise<ParallelUltraLogLogU32> {
    const options = validateOptions(rawOptions);
    const registerCount = 1 << options.precision;
    const statesOffset = align64(options.maxValues * 4);
    const byteLength = statesOffset + registerCount * options.workerCount;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_SHARED_BYTES) {
      throw new RangeError("parallel UltraLogLog shared layout exceeds 32-bit addressing");
    }
    const shared = new SharedArrayBuffer(byteLength);
    const result = new UltraLogLogU32(options.precision);
    const workers: WorkerControl[] = [];
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
          }),
        );
      }
      return new ParallelUltraLogLogU32(options, shared, statesOffset, result, workers);
    } catch (error) {
      await stopWorkers(workers);
      result[Symbol.dispose]();
      throw error;
    }
  }

  get lastStrategy(): UltraLogLogExecutionStrategy | null {
    this.#assertIdle();
    return this.#lastStrategy;
  }

  async replace(values: Uint32Array): Promise<number> {
    this.#assertIdle();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (values.length > this.maxValues) throw new RangeError("values exceed maxValues");
    this.#busy = true;
    try {
      if (values.length < this.workerThreshold) {
        this.#result.replace(values);
        this.#lastStrategy = "serial";
        return this.#result.estimate();
      }
      new Uint32Array(this.#shared, 0, values.length).set(values);
      const rowsPerWorker = Math.ceil(values.length / this.workerCount);
      await Promise.all(this.#workers.map((worker, index) => {
        const rowStart = index * rowsPerWorker;
        return worker.run({
          type: "build",
          rowStart,
          rowCount: Math.max(0, Math.min(rowsPerWorker, values.length - rowStart)),
        });
      }));
      this.#result.reset();
      for (let index = 0; index < this.workerCount; index++) {
        this.#result.mergeState(
          new Uint8Array(
            this.#shared,
            this.#statesOffset + index * this.registerCount,
            this.registerCount,
          ),
        );
      }
      this.#lastStrategy = "workers";
      return this.#result.estimate();
    } finally {
      this.#busy = false;
    }
  }

  estimate(): number {
    this.#assertIdle();
    return this.#result.estimate();
  }

  state(): Uint8Array {
    this.#assertIdle();
    return this.#result.state();
  }

  stateInto(output: Uint8Array): void {
    this.#assertIdle();
    this.#result.stateInto(output);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose ParallelUltraLogLogU32 while busy");
    this.#disposed = true;
    await stopWorkers(this.#workers);
    this.#result[Symbol.dispose]();
    new Uint8Array(this.#shared).fill(0);
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("ParallelUltraLogLogU32 has been disposed");
    if (this.#busy) throw new Error("ParallelUltraLogLogU32 is busy");
  }
}

function validateOptions(
  options: ParallelUltraLogLogOptions,
): Required<ParallelUltraLogLogOptions> {
  if (options === null || typeof options !== "object") throw new TypeError("options required");
  const precision = options.precision ?? 14;
  if (!Number.isSafeInteger(precision) || precision < 3 || precision > 20) {
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
  const workerThreshold = options.workerThreshold ?? DEFAULT_WORKER_THRESHOLD;
  if (!Number.isSafeInteger(workerThreshold) || workerThreshold < 0) {
    throw new RangeError("workerThreshold must be a non-negative safe integer");
  }
  return {
    precision,
    maxValues: options.maxValues,
    workerCount: options.workerCount,
    workerThreshold,
  };
}

function align64(value: number): number {
  return Math.ceil(value / 64) * 64;
}

async function startWorker(init: UltraLogLogWorkerInit): Promise<WorkerControl> {
  const worker = await createWorker();
  let ready = false;
  let requestId = 0;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      if (!ready) reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    const onMessage = (message: UltraLogLogWorkerResponse) => {
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
    const onError = (error: Error) => fail(error);
    if (typeof worker.on === "function") {
      worker.on("message", onMessage);
      worker.on("error", onError);
    } else {
      worker.onmessage = (event) => onMessage(event.data);
      worker.onerror = (event) => fail(event.error ?? new Error(event.message));
    }
    worker.postMessage(init);
  });
}

async function createWorker(): Promise<WorkerLike> {
  if (typeof globalThis.Worker === "function") {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  const nodeWorkerThreads = "node:" + "worker_threads";
  const { Worker: NodeWorker } = await import(/* @vite-ignore */ nodeWorkerThreads);
  const nodeWorkerPath = "./worker." + "js";
  return new NodeWorker(new URL(nodeWorkerPath, import.meta.url)) as unknown as WorkerLike;
}

async function stopWorkers(workers: readonly WorkerControl[]): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.run({ type: "stop" })));
  for (const worker of workers) worker.worker.terminate();
}
