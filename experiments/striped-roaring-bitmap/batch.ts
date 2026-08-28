import type {
  RoaringPairInput,
  StripedRoaringWorkerInit,
  StripedRoaringWorkerOperation,
  StripedRoaringWorkerResponse,
} from "./protocol.ts";

export type { RoaringPairInput } from "./protocol.ts";

export interface StripedRoaringIntersectionBatchOptions {
  readonly workerCount: number;
}

interface WorkerControl {
  readonly worker: Worker;
  readonly pairIndices: readonly number[];
  run(operation: StripedRoaringWorkerOperation): Promise<Float64Array | undefined>;
}

/** Admission experiment for batched cardinality over Worker-resident Roaring set pairs. */
export class StripedRoaringIntersectionBatch implements AsyncDisposable {
  readonly pairCount: number;
  readonly workerCount: number;
  readonly #workers: readonly WorkerControl[];
  #busy = false;
  #disposed = false;

  private constructor(pairCount: number, workers: readonly WorkerControl[]) {
    this.pairCount = pairCount;
    this.workerCount = workers.length;
    this.#workers = workers;
  }

  static async create(
    pairs: readonly RoaringPairInput[],
    options: StripedRoaringIntersectionBatchOptions,
  ): Promise<StripedRoaringIntersectionBatch> {
    validateInputs(pairs, options);
    const assignments = Array.from(
      { length: options.workerCount },
      () => ({ pairs: [] as RoaringPairInput[], indices: [] as number[] }),
    );
    for (let index = 0; index < pairs.length; index++) {
      const assignment = assignments[index % assignments.length]!;
      assignment.pairs.push(pairs[index]!);
      assignment.indices.push(index);
    }
    const workers: WorkerControl[] = [];
    try {
      for (const assignment of assignments) {
        workers.push(
          await startWorker({ type: "init", pairs: assignment.pairs }, assignment.indices),
        );
      }
      return new StripedRoaringIntersectionBatch(pairs.length, workers);
    } catch (error) {
      await stopWorkers(workers);
      throw error;
    }
  }

  async intersectionCardinalitiesInto(output: Float64Array): Promise<number> {
    this.#assertIdle();
    if (!(output instanceof Float64Array) || output.length < this.pairCount) {
      throw new RangeError("output must cover every resident pair");
    }
    this.#busy = true;
    try {
      const results = await Promise.all(
        this.#workers.map((worker) => worker.run({ type: "intersections" })),
      );
      for (let workerIndex = 0; workerIndex < this.#workers.length; workerIndex++) {
        const indices = this.#workers[workerIndex]!.pairIndices;
        const counts = results[workerIndex];
        if (counts === undefined || counts.length !== indices.length) {
          throw new Error("striped Roaring Worker returned an invalid result");
        }
        for (let index = 0; index < indices.length; index++) {
          output[indices[index]!] = counts[index]!;
        }
      }
      return this.pairCount;
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose StripedRoaringIntersectionBatch while busy");
    this.#disposed = true;
    await stopWorkers(this.#workers);
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("StripedRoaringIntersectionBatch has been disposed");
    if (this.#busy) throw new Error("StripedRoaringIntersectionBatch is busy");
  }
}

function validateInputs(
  pairs: readonly RoaringPairInput[],
  options: StripedRoaringIntersectionBatchOptions,
): void {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new RangeError("pairs must contain at least one resident pair");
  }
  if (
    options === null || typeof options !== "object" ||
    !Number.isSafeInteger(options.workerCount) || options.workerCount < 1 ||
    options.workerCount > Math.min(32, pairs.length)
  ) {
    throw new RangeError("workerCount must be between one and the resident pair count");
  }
  for (const pair of pairs) {
    if (
      pair === null || typeof pair !== "object" || !(pair.left instanceof Uint32Array) ||
      !(pair.right instanceof Uint32Array)
    ) throw new TypeError("each pair must contain Uint32Array left and right inputs");
  }
}

function startWorker(
  init: StripedRoaringWorkerInit,
  pairIndices: readonly number[],
): Promise<WorkerControl> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let ready = false;
  let requestId = 0;
  const pending = new Map<
    number,
    { resolve(value: Float64Array | undefined): void; reject(error: Error): void }
  >();
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      worker.terminate();
      if (!ready) reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    worker.onmessage = (event: MessageEvent<StripedRoaringWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        ready = true;
        resolve({
          worker,
          pairIndices,
          run(operation) {
            const current = ++requestId;
            return new Promise((resolveTask, rejectTask) => {
              pending.set(current, { resolve: resolveTask, reject: rejectTask });
              worker.postMessage({ ...operation, requestId: current });
            });
          },
        });
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.message);
        if (message.requestId === undefined) fail(error);
        else {
          pending.get(message.requestId)?.reject(error);
          pending.delete(message.requestId);
        }
        return;
      }
      const task = pending.get(message.requestId);
      if (task === undefined) return;
      pending.delete(message.requestId);
      task.resolve(message.type === "intersections" ? message.counts : undefined);
    };
    worker.onerror = (event) => fail(new Error(event.message));
    worker.onmessageerror = () => fail(new Error("striped Roaring Worker message error"));
    worker.postMessage(init);
  });
}

async function stopWorkers(workers: readonly WorkerControl[]): Promise<void> {
  await Promise.all(workers.map(async (control) => {
    try {
      await control.run({ type: "stop" });
    } finally {
      control.worker.terminate();
    }
  }));
}
