import { SharedBuffer } from "../../src/shared-buffer/mod.ts";
import { instantiateHybridKernels } from "./kernel.ts";
import type {
  HybridWorkerInit,
  HybridWorkerRequest,
  HybridWorkerResponse,
  HybridWorkerSearch,
} from "./parallel_protocol.ts";
import { SharedSelectionMask } from "./shared_selection_mask.ts";

let state: WorkerState | undefined;

self.onmessage = async (event: MessageEvent<HybridWorkerRequest>) => {
  try {
    if (event.data.type === "init") {
      if (state !== undefined) throw new Error("hybrid Worker is already initialized");
      state = await WorkerState.create(event.data);
      post({ type: "ready", lease: state.shared.workerLease });
      return;
    }
    if (state === undefined) throw new Error("hybrid Worker is not initialized");
    if (event.data.type === "stop") {
      state[Symbol.dispose]();
      state = undefined;
      post({ type: "stopped" });
      self.close();
      return;
    }
    post(state.search(event.data));
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};

class WorkerState implements Disposable {
  readonly shared: SharedBuffer;
  readonly #init: HybridWorkerInit;
  readonly #kernels: Awaited<ReturnType<typeof instantiateHybridKernels>>;
  readonly #predicateMask: SharedSelectionMask;
  readonly #allMask: SharedSelectionMask;

  private constructor(
    shared: SharedBuffer,
    init: HybridWorkerInit,
    kernels: Awaited<ReturnType<typeof instantiateHybridKernels>>,
  ) {
    this.shared = shared;
    this.#init = init;
    this.#kernels = kernels;
    this.#predicateMask = SharedSelectionMask.attach(shared, init.predicateMaskOffset);
    this.#allMask = SharedSelectionMask.attach(shared, init.allMaskOffset);
  }

  static async create(init: HybridWorkerInit): Promise<WorkerState> {
    const shared = await SharedBuffer.attach(init.memory);
    try {
      return new WorkerState(shared, init, await instantiateHybridKernels(shared.memory));
    } catch (error) {
      shared[Symbol.dispose]();
      throw error;
    }
  }

  search(task: HybridWorkerSearch): Extract<HybridWorkerResponse, { type: "result" }> {
    const mask = task.mask === "predicate" ? this.#predicateMask : this.#allMask;
    const view = mask.read(task.generation);
    const maskOffset = view.dataByteOffset + (this.#init.rowStart >>> 5) * 4;
    const vectorOffset = this.#init.vectorsOffset +
      this.#init.rowStart * this.#init.dimensions * 4;
    this.#kernels.masked_squared_l2_top1_pdx64(
      absolute(this.shared, vectorOffset),
      absolute(this.shared, this.#init.queryOffset),
      this.#init.rowCount,
      this.#init.dimensions,
      absolute(this.shared, maskOffset),
      absolute(this.shared, this.#init.scratchOffset),
      absolute(this.shared, this.#init.resultOffset),
    );
    const selectedCount = this.shared.uint32Array(this.#init.resultOffset, 3)[2]!;
    const pairs = selectLocalTopK(
      this.shared,
      this.#init.scratchOffset,
      maskOffset,
      this.#init.rowStart,
      this.#init.rowCount,
      Math.min(task.k, selectedCount),
    );
    return {
      type: "result",
      epoch: task.epoch,
      ids: pairs.map((pair) => pair.id),
      distances: pairs.map((pair) => pair.distance),
      selectedCount,
      exhausted: task.k >= selectedCount,
    };
  }

  [Symbol.dispose](): void {
    this.shared[Symbol.dispose]();
  }
}

interface Pair {
  readonly id: number;
  readonly distance: number;
}

function selectLocalTopK(
  shared: SharedBuffer,
  scratchOffset: number,
  maskOffset: number,
  rowStart: number,
  rowCount: number,
  k: number,
): Pair[] {
  if (k === 0) return [];
  const scores = float32View(shared, scratchOffset, rowCount);
  const words = shared.uint32Array(maskOffset, Math.ceil(rowCount / 32));
  const heap: Pair[] = [];
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    let word = words[wordIndex]! >>> 0;
    while (word !== 0) {
      const bit = 31 - Math.clz32(word & -word);
      const localId = wordIndex * 32 + bit;
      if (localId < rowCount) {
        pushBounded(heap, { id: rowStart + localId, distance: scores[localId]! }, k);
      }
      word = (word & (word - 1)) >>> 0;
    }
  }
  heap.sort(comparePair);
  return heap;
}

function pushBounded(heap: Pair[], pair: Pair, k: number): void {
  if (heap.length < k) {
    heap.push(pair);
    siftUp(heap, heap.length - 1);
  } else if (comparePair(pair, heap[0]!) < 0) {
    heap[0] = pair;
    siftDown(heap, 0);
  }
}

function siftUp(heap: Pair[], index: number): void {
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (comparePair(heap[parent]!, heap[index]!) >= 0) return;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function siftDown(heap: Pair[], index: number): void {
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let child = left;
    if (right < heap.length && comparePair(heap[right]!, heap[left]!) > 0) child = right;
    if (comparePair(heap[index]!, heap[child]!) >= 0) return;
    [heap[index], heap[child]] = [heap[child]!, heap[index]!];
    index = child;
  }
}

function comparePair(left: Pair, right: Pair): number {
  return left.distance - right.distance || left.id - right.id;
}

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, shared.dataOffset + byteOffset, length);
}

function absolute(shared: SharedBuffer, byteOffset: number): number {
  return shared.dataOffset + byteOffset;
}

function post(message: HybridWorkerResponse): void {
  self.postMessage(message);
}
