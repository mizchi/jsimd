import { compileSharedBufferModule, ShardedBitmap, SharedBuffer } from "@mizchi/jsimd-shared";
import {
  compileParallelBloomModule,
  instantiateParallelBloomKernels,
  type ParallelBloomKernels,
} from "./kernel.ts";
import type {
  ParallelBloomWorkerInit,
  ParallelBloomWorkerOperation,
  ParallelBloomWorkerResponse,
} from "./protocol.ts";

const BITS_PER_BLOCK = 128;
const WASM_PAGE_BYTES = 65_536;

export interface ParallelBlockedBloomFilterOptions {
  readonly maxBuildKeys: number;
  readonly maxQueryKeys: number;
  readonly workerCount: number;
  readonly targetBitsPerKey?: number;
}

interface Layout {
  readonly bitmapBytes: number;
  readonly buildKeysOffset: number;
  readonly queryKeysOffset: number;
  readonly outputOffset: number;
  readonly byteLength: number;
}

interface WorkerControl {
  readonly worker: Worker;
  run(operation: ParallelBloomWorkerOperation): Promise<void>;
}

/** Admission experiment: persistent Workers build private Bloom shards followed by one SIMD OR. */
export class ParallelBlockedBloomFilterU32 implements AsyncDisposable {
  readonly maxBuildKeys: number;
  readonly maxQueryKeys: number;
  readonly workerCount: number;
  readonly blockCount: number;
  readonly byteLength: number;
  readonly bitsPerKey: number;
  readonly #shared: SharedBuffer;
  readonly #bitmap: ShardedBitmap;
  readonly #kernels: ParallelBloomKernels;
  readonly #workers: readonly WorkerControl[];
  readonly #layout: Layout;
  #generation = 0;
  #busy = false;
  #disposed = false;

  private constructor(
    options: Required<ParallelBlockedBloomFilterOptions>,
    blockCount: number,
    shared: SharedBuffer,
    bitmap: ShardedBitmap,
    kernels: ParallelBloomKernels,
    workers: readonly WorkerControl[],
    layout: Layout,
  ) {
    this.maxBuildKeys = options.maxBuildKeys;
    this.maxQueryKeys = options.maxQueryKeys;
    this.workerCount = options.workerCount;
    this.blockCount = blockCount;
    this.byteLength = layout.byteLength;
    this.bitsPerKey = options.maxBuildKeys === 0
      ? Number.POSITIVE_INFINITY
      : blockCount * BITS_PER_BLOCK / options.maxBuildKeys;
    this.#shared = shared;
    this.#bitmap = bitmap;
    this.#kernels = kernels;
    this.#workers = workers;
    this.#layout = layout;
  }

  static async create(
    rawOptions: ParallelBlockedBloomFilterOptions,
  ): Promise<ParallelBlockedBloomFilterU32> {
    const options = validateOptions(rawOptions);
    const blockCount = Math.max(
      1,
      Math.ceil(options.maxBuildKeys * options.targetBitsPerKey / BITS_PER_BLOCK),
    );
    const layout = createLayout(options, blockCount);
    const maxWorkers = options.workerCount + 1;
    const headerBytes = (maxWorkers + 1) * 64;
    const pages = Math.max(1, Math.ceil((headerBytes + layout.byteLength) / WASM_PAGE_BYTES));
    const [sharedModule, bloomModule] = await Promise.all([
      compileSharedBufferModule(),
      compileParallelBloomModule(),
    ]);
    const shared = await SharedBuffer.create({
      initialPages: pages,
      maximumPages: pages,
      maxWorkers,
      module: sharedModule,
    });
    const workers: WorkerControl[] = [];
    try {
      const bitmap = ShardedBitmap.initialize(shared, 0, {
        capacity: blockCount * BITS_PER_BLOCK,
        shardCount: options.workerCount,
      });
      const kernels = instantiateParallelBloomKernels(bloomModule, shared.memory);
      const modules = { shared: sharedModule, bloom: bloomModule };
      for (let shardIndex = 0; shardIndex < options.workerCount; shardIndex++) {
        workers.push(
          await startWorker({
            type: "init",
            memory: shared.memory,
            modules,
            bitmapOffset: 0,
            buildKeysOffset: layout.buildKeysOffset,
            shardIndex,
          }),
        );
      }
      return new ParallelBlockedBloomFilterU32(
        options,
        blockCount,
        shared,
        bitmap,
        kernels,
        workers,
        layout,
      );
    } catch (error) {
      await stopWorkers(workers);
      shared[Symbol.dispose]();
      throw error;
    }
  }

  async replace(keys: Uint32Array): Promise<number> {
    this.#assertIdle();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (keys.length > this.maxBuildKeys) throw new RangeError("build keys exceed maxBuildKeys");
    this.#busy = true;
    try {
      this.#shared.uint32Array(this.#layout.buildKeysOffset, keys.length).set(keys);
      const rowsPerWorker = Math.ceil(keys.length / this.workerCount);
      await Promise.all(
        this.#workers.map((worker, index) => {
          const rowStart = index * rowsPerWorker;
          return worker.run({
            type: "build",
            rowStart,
            rowCount: Math.max(0, Math.min(rowsPerWorker, keys.length - rowStart)),
          });
        }),
      );
      this.#generation = this.#bitmap.reduceOr().generation;
      return this.#generation;
    } finally {
      this.#busy = false;
    }
  }

  mayContainMany(keys: Uint32Array, output: Uint8Array): number {
    this.#assertIdle();
    if (this.#generation === 0) throw new Error("Bloom filter has not published a generation");
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (keys.length > this.maxQueryKeys) throw new RangeError("query keys exceed maxQueryKeys");
    if (!(output instanceof Uint8Array) || output.length < keys.length) {
      throw new RangeError("output must cover every query key");
    }
    this.#shared.uint32Array(this.#layout.queryKeysOffset, keys.length).set(keys);
    const count = this.#kernels.may_contain_many(
      this.#shared.dataOffset + this.#bitmap.resultByteOffset,
      this.blockCount,
      this.#shared.dataOffset + this.#layout.queryKeysOffset,
      this.#shared.dataOffset + this.#layout.outputOffset,
      keys.length,
    );
    output.set(this.#shared.uint8Array(this.#layout.outputOffset, keys.length));
    return count;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose ParallelBlockedBloomFilterU32 while busy");
    this.#disposed = true;
    await stopWorkers(this.#workers);
    this.#shared[Symbol.dispose]();
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("ParallelBlockedBloomFilterU32 has been disposed");
    if (this.#busy) throw new Error("ParallelBlockedBloomFilterU32 is busy");
  }
}

function createLayout(
  options: Required<ParallelBlockedBloomFilterOptions>,
  blockCount: number,
): Layout {
  const bitmapBytes = ShardedBitmap.byteLengthFor({
    capacity: blockCount * BITS_PER_BLOCK,
    shardCount: options.workerCount,
  });
  const buildKeysOffset = alignTo(bitmapBytes, 64);
  const queryKeysOffset = alignTo(buildKeysOffset + options.maxBuildKeys * 4, 64);
  const outputOffset = alignTo(queryKeysOffset + options.maxQueryKeys * 4, 64);
  const byteLength = alignTo(outputOffset + options.maxQueryKeys, 64);
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("parallel Bloom layout is too large");
  return { bitmapBytes, buildKeysOffset, queryKeysOffset, outputOffset, byteLength };
}

function validateOptions(
  options: ParallelBlockedBloomFilterOptions,
): Required<ParallelBlockedBloomFilterOptions> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  validateLength(options.maxBuildKeys, "maxBuildKeys");
  validateLength(options.maxQueryKeys, "maxQueryKeys");
  if (
    !Number.isSafeInteger(options.workerCount) || options.workerCount < 2 ||
    options.workerCount > 32
  ) {
    throw new RangeError("workerCount must be an integer between 2 and 32");
  }
  const targetBitsPerKey = options.targetBitsPerKey ?? 10;
  if (!Number.isFinite(targetBitsPerKey) || targetBitsPerKey < 1 || targetBitsPerKey > 128) {
    throw new RangeError("targetBitsPerKey must be between 1 and 128");
  }
  return { ...options, targetBitsPerKey };
}

function validateLength(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fff_ffff) {
    throw new RangeError(`${name} must be a non-negative Wasm-addressable integer`);
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function startWorker(init: ParallelBloomWorkerInit): Promise<WorkerControl> {
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
    worker.onmessage = (event: MessageEvent<ParallelBloomWorkerResponse>) => {
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
