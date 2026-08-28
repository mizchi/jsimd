import type { SharedBuffer } from "@mizchi/jsimd-shared";
import { type HashJoinProbeResult, PartitionedHashJoinTableU32 } from "./partitioned_hash_join.ts";
import type {
  PartitionedHashJoinWorkerInit,
  PartitionedHashJoinWorkerOperation,
  PartitionedHashJoinWorkerResponse,
} from "./partitioned_hash_join_protocol.ts";
import { compileOlapWorkerModules } from "./runtime_modules.ts";

export interface PartitionedHashJoinProbeInput {
  readonly keysByteOffset: number;
  readonly rowIdsByteOffset: number;
  readonly rowCount: number;
}

export interface PartitionedHashJoinOutput {
  readonly probeRowIdsByteOffset: number;
  readonly buildRowIdsByteOffset: number;
  readonly capacity: number;
}

interface WorkerControl {
  readonly worker: Worker;
  run(operation: PartitionedHashJoinWorkerOperation): Promise<HashJoinProbeResult>;
}

/** Persistent read-only probe Workers with caller-owned, disjoint output shards. */
export class PartitionedHashJoinWorkerPool implements AsyncDisposable {
  readonly workerCount: number;
  readonly #controls: readonly WorkerControl[];
  #busy = false;
  #disposed = false;

  private constructor(controls: readonly WorkerControl[]) {
    this.#controls = controls;
    this.workerCount = controls.length;
  }

  static async create(
    shared: SharedBuffer,
    table: PartitionedHashJoinTableU32,
    input: PartitionedHashJoinProbeInput,
    outputs: readonly PartitionedHashJoinOutput[],
  ): Promise<PartitionedHashJoinWorkerPool> {
    if (outputs.length < 2) throw new RangeError("at least two Worker outputs are required");
    validateNonNegative(input.rowCount, "rowCount");
    shared.uint32Array(input.keysByteOffset, input.rowCount);
    shared.uint32Array(input.rowIdsByteOffset, input.rowCount);
    PartitionedHashJoinTableU32.attach(shared, table.byteOffset);
    validateOutputs(shared, table, input, outputs);
    const modules = await compileOlapWorkerModules();
    const shardRows = Math.ceil(input.rowCount / outputs.length);
    const controls: WorkerControl[] = [];
    try {
      for (let worker = 0; worker < outputs.length; worker++) {
        const output = outputs[worker]!;
        const rowStart = worker * shardRows;
        controls.push(
          await startWorker({
            type: "init",
            memory: shared.memory,
            modules,
            tableOffset: table.byteOffset,
            probeKeysOffset: input.keysByteOffset,
            probeRowIdsOffset: input.rowIdsByteOffset,
            rowStart,
            rowCount: Math.max(0, Math.min(shardRows, input.rowCount - rowStart)),
            outputProbeRowIdsOffset: output.probeRowIdsByteOffset,
            outputBuildRowIdsOffset: output.buildRowIdsByteOffset,
            outputCapacity: output.capacity,
          }),
        );
      }
      return new PartitionedHashJoinWorkerPool(controls);
    } catch (error) {
      await stopWorkers(controls);
      throw error;
    }
  }

  async probe(): Promise<HashJoinProbeResult> {
    this.#assertIdle();
    this.#busy = true;
    try {
      const results = await Promise.all(
        this.#controls.map((control) => control.run({ type: "probe" })),
      );
      return results.reduce(
        (total, result) => ({
          matchCount: total.matchCount + result.matchCount,
          written: total.written + result.written,
          truncated: total.truncated || result.truncated,
        }),
        { matchCount: 0, written: 0, truncated: false },
      );
    } finally {
      this.#busy = false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("cannot dispose PartitionedHashJoinWorkerPool during probing");
    this.#disposed = true;
    await stopWorkers(this.#controls);
  }

  #assertIdle(): void {
    if (this.#disposed) throw new Error("PartitionedHashJoinWorkerPool has been disposed");
    if (this.#busy) throw new Error("PartitionedHashJoinWorkerPool probe is already running");
  }
}

function validateOutputs(
  shared: SharedBuffer,
  table: PartitionedHashJoinTableU32,
  input: PartitionedHashJoinProbeInput,
  outputs: readonly PartitionedHashJoinOutput[],
): void {
  const ranges: Array<{ offset: number; length: number; name: string }> = [
    { offset: table.byteOffset, length: table.byteLength, name: "table" },
    { offset: input.keysByteOffset, length: input.rowCount * 4, name: "probe keys" },
    { offset: input.rowIdsByteOffset, length: input.rowCount * 4, name: "probe row IDs" },
  ];
  outputs.forEach((output, worker) => {
    validateNonNegative(output.capacity, `outputs[${worker}].capacity`);
    shared.uint32Array(output.probeRowIdsByteOffset, output.capacity);
    shared.uint32Array(output.buildRowIdsByteOffset, output.capacity);
    ranges.push(
      {
        offset: output.probeRowIdsByteOffset,
        length: output.capacity * 4,
        name: `outputs[${worker}].probe`,
      },
      {
        offset: output.buildRowIdsByteOffset,
        length: output.capacity * 4,
        name: `outputs[${worker}].build`,
      },
    );
  });
  for (let left = 0; left < ranges.length; left++) {
    for (let right = left + 1; right < ranges.length; right++) {
      const a = ranges[left]!;
      const b = ranges[right]!;
      if (
        a.length !== 0 && b.length !== 0 && a.offset < b.offset + b.length &&
        b.offset < a.offset + a.length
      ) {
        throw new RangeError(`${a.name} overlaps ${b.name}`);
      }
    }
  }
}

function startWorker(init: PartitionedHashJoinWorkerInit): Promise<WorkerControl> {
  const worker = new Worker(new URL("./partitioned_hash_join_worker.ts", import.meta.url), {
    type: "module",
  });
  let requestId = 0;
  let ready = false;
  const pending = new Map<
    number,
    { resolve(result: HashJoinProbeResult): void; reject(error: Error): void }
  >();
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      if (!ready) reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    };
    worker.onmessage = (event: MessageEvent<PartitionedHashJoinWorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        ready = true;
        resolve({
          worker,
          run(operation) {
            const current = ++requestId;
            return new Promise<HashJoinProbeResult>((resolveTask, rejectTask) => {
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
          matchCount: message.matchCount,
          written: message.written,
          truncated: message.truncated,
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

function validateNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a non-negative u32 integer`);
  }
}
