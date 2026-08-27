import {
  dijkstra_scalar as wasmDijkstraScalar,
  dijkstra_simd as wasmDijkstraSimd,
  memory,
  pop_simd as wasmPopSimd,
  push as wasmPush,
  push_many as wasmPushMany,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../../../packages/jsimd/src/internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);
const BYTES_PER_ELEMENT = 4;

type DijkstraKernel = (
  offsets: number,
  targets: number,
  weights: number,
  nodeCount: number,
  start: number,
  target: number,
  distances: number,
  previous: number,
  heapPriorities: number,
  heapIds: number,
  outputId: number,
  outputPriority: number,
) => number;

export interface PriorityQueueEntry {
  readonly id: number;
  readonly priority: number;
}

/** Experimental growable f32-priority/u32-ID 4-ary min heap. */
export class SimdPriorityQueueU32 implements Disposable {
  #allocation: Allocation;
  #capacity: number;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = 16) {
    validateNonNegativeInteger(initialCapacity, "initialCapacity");
    this.#capacity = nextCapacity(initialCapacity);
    this.#allocation = allocator.allocate(this.#byteLength());
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get size(): number {
    this.#assertAlive();
    return this.#size;
  }

  get capacity(): number {
    this.#assertAlive();
    return this.#capacity;
  }

  push(id: number, priority: number): this {
    this.#assertAlive();
    validateUint32(id, "id");
    validatePriority(priority);
    this.#ensureCapacity(this.#size + 1);
    this.#size = wasmPush(
      this.#prioritiesPointer(),
      this.#idsPointer(),
      this.#size,
      id,
      priority,
    );
    return this;
  }

  pushMany(ids: Uint32Array, priorities: Float32Array): this {
    this.#assertAlive();
    if (!(ids instanceof Uint32Array) || !(priorities instanceof Float32Array)) {
      throw new TypeError("ids and priorities must be Uint32Array and Float32Array");
    }
    if (ids.length !== priorities.length) throw new RangeError("batch lengths must match");
    for (const priority of priorities) validatePriority(priority);
    this.#ensureCapacity(this.#size + ids.length);
    const scratch = allocator.allocate(ids.byteLength + priorities.byteLength);
    try {
      const inputIds = scratch.pointer;
      const inputPriorities = inputIds + ids.byteLength;
      new Uint32Array(memory.buffer, inputIds, ids.length).set(ids);
      new Float32Array(memory.buffer, inputPriorities, priorities.length).set(priorities);
      this.#size = wasmPushMany(
        this.#prioritiesPointer(),
        this.#idsPointer(),
        this.#size,
        inputIds,
        inputPriorities,
        ids.length,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  peek(): PriorityQueueEntry | undefined {
    this.#assertAlive();
    if (this.#size === 0) return undefined;
    return { id: this.#ids()[0]!, priority: this.#priorities()[0]! };
  }

  pop(): PriorityQueueEntry | undefined {
    const ids = new Uint32Array(1);
    const priorities = new Float32Array(1);
    return this.popInto(ids, priorities) ? { id: ids[0]!, priority: priorities[0]! } : undefined;
  }

  popInto(ids: Uint32Array, priorities: Float32Array): boolean {
    this.#assertAlive();
    if (!(ids instanceof Uint32Array) || ids.length < 1) {
      throw new RangeError("id output must contain at least one element");
    }
    if (!(priorities instanceof Float32Array) || priorities.length < 1) {
      throw new RangeError("priority output must contain at least one element");
    }
    if (this.#size === 0) return false;
    this.#size = wasmPopSimd(
      this.#prioritiesPointer(),
      this.#idsPointer(),
      this.#size,
      this.#outputIdPointer(),
      this.#outputPriorityPointer(),
    );
    ids[0] = new Uint32Array(memory.buffer, this.#outputIdPointer(), 1)[0]!;
    priorities[0] = new Float32Array(memory.buffer, this.#outputPriorityPointer(), 1)[0]!;
    return true;
  }

  clear(): this {
    this.#assertAlive();
    this.#size = 0;
    return this;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    const previous = this.#allocation;
    const previousCapacity = this.#capacity;
    const next = nextCapacity(required);
    const nextAllocation = allocator.allocate(next * BYTES_PER_ELEMENT * 2 + 8);
    try {
      new Float32Array(memory.buffer, nextAllocation.pointer, next).set(
        new Float32Array(memory.buffer, previous.pointer, previousCapacity).subarray(0, this.#size),
      );
      new Uint32Array(
        memory.buffer,
        nextAllocation.pointer + next * BYTES_PER_ELEMENT,
        next,
      ).set(
        new Uint32Array(
          memory.buffer,
          previous.pointer + previousCapacity * BYTES_PER_ELEMENT,
          previousCapacity,
        ).subarray(0, this.#size),
      );
    } catch (error) {
      allocator.release(nextAllocation);
      throw error;
    }
    this.#capacity = next;
    this.#allocation = nextAllocation;
    allocator.release(previous);
  }

  #byteLength(): number {
    return this.#capacity * BYTES_PER_ELEMENT * 2 + 8;
  }

  #prioritiesPointer(): number {
    return this.#allocation.pointer;
  }

  #idsPointer(): number {
    return this.#allocation.pointer + this.#capacity * BYTES_PER_ELEMENT;
  }

  #outputIdPointer(): number {
    return this.#idsPointer() + this.#capacity * BYTES_PER_ELEMENT;
  }

  #outputPriorityPointer(): number {
    return this.#outputIdPointer() + BYTES_PER_ELEMENT;
  }

  #priorities(): Float32Array {
    return new Float32Array(memory.buffer, this.#prioritiesPointer(), this.#capacity);
  }

  #ids(): Uint32Array {
    return new Uint32Array(memory.buffer, this.#idsPointer(), this.#capacity);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("SimdPriorityQueueU32 has been disposed");
  }
}

export interface ShortestPathResult {
  readonly distance: number;
  readonly path: Uint32Array;
}

/** Experimental immutable CSR graph with reusable Wasm-resident Dijkstra scratch storage. */
export class DijkstraCsrGraph implements Disposable {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly #allocation: Allocation;
  readonly #layout: GraphLayout;
  #disposed = false;

  private constructor(
    offsets: Uint32Array,
    targets: Uint32Array,
    weights: Float32Array,
  ) {
    this.nodeCount = offsets.length - 1;
    this.edgeCount = targets.length;
    this.#layout = createGraphLayout(this.nodeCount, this.edgeCount);
    this.#allocation = allocator.allocate(this.#layout.byteLength);
    try {
      this.#uint32(this.#layout.offsets, offsets.length).set(offsets);
      this.#uint32(this.#layout.targets, targets.length).set(targets);
      this.#float32(this.#layout.weights, weights.length).set(weights);
    } catch (error) {
      allocator.release(this.#allocation);
      throw error;
    }
  }

  static from(
    offsets: Uint32Array,
    targets: Uint32Array,
    weights: Float32Array,
  ): DijkstraCsrGraph {
    validateGraph(offsets, targets, weights);
    return new DijkstraCsrGraph(offsets, targets, weights);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  shortestPath(start: number, target: number): ShortestPathResult {
    return this.#shortestPath(start, target, wasmDijkstraSimd);
  }

  shortestPathScalar(start: number, target: number): ShortestPathResult {
    return this.#shortestPath(start, target, wasmDijkstraScalar);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #shortestPath(start: number, target: number, kernel: DijkstraKernel): ShortestPathResult {
    this.#assertAlive();
    validateNode(start, this.nodeCount, "start");
    validateNode(target, this.nodeCount, "target");
    const pointer = this.#allocation.pointer;
    const distance = kernel(
      pointer + this.#layout.offsets,
      pointer + this.#layout.targets,
      pointer + this.#layout.weights,
      this.nodeCount,
      start,
      target,
      pointer + this.#layout.distances,
      pointer + this.#layout.previous,
      pointer + this.#layout.heapPriorities,
      pointer + this.#layout.heapIds,
      pointer + this.#layout.outputId,
      pointer + this.#layout.outputPriority,
    );
    if (distance === Infinity) return { distance, path: new Uint32Array() };
    const previous = this.#uint32(this.#layout.previous, this.nodeCount);
    const reversed: number[] = [];
    let cursor = target;
    for (let count = 0; count <= this.nodeCount; count++) {
      reversed.push(cursor);
      if (cursor === start) break;
      cursor = previous[cursor]!;
      if (cursor === 0xffff_ffff) throw new Error("invalid predecessor chain");
    }
    if (reversed[reversed.length - 1] !== start) throw new Error("predecessor cycle");
    reversed.reverse();
    return { distance, path: Uint32Array.from(reversed) };
  }

  #uint32(relativeOffset: number, length: number): Uint32Array {
    return new Uint32Array(memory.buffer, this.#allocation.pointer + relativeOffset, length);
  }

  #float32(relativeOffset: number, length: number): Float32Array {
    return new Float32Array(memory.buffer, this.#allocation.pointer + relativeOffset, length);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("DijkstraCsrGraph has been disposed");
  }
}

interface GraphLayout {
  readonly offsets: number;
  readonly targets: number;
  readonly weights: number;
  readonly distances: number;
  readonly previous: number;
  readonly heapPriorities: number;
  readonly heapIds: number;
  readonly outputId: number;
  readonly outputPriority: number;
  readonly byteLength: number;
}

function createGraphLayout(nodeCount: number, edgeCount: number): GraphLayout {
  const offsets = 0;
  const targets = offsets + (nodeCount + 1) * BYTES_PER_ELEMENT;
  const weights = targets + edgeCount * BYTES_PER_ELEMENT;
  const distances = weights + edgeCount * BYTES_PER_ELEMENT;
  const previous = distances + nodeCount * BYTES_PER_ELEMENT;
  const heapCapacity = Math.max(1, edgeCount + 1);
  const heapPriorities = previous + nodeCount * BYTES_PER_ELEMENT;
  const heapIds = heapPriorities + heapCapacity * BYTES_PER_ELEMENT;
  const outputId = heapIds + heapCapacity * BYTES_PER_ELEMENT;
  const outputPriority = outputId + BYTES_PER_ELEMENT;
  const byteLength = outputPriority + BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(byteLength) || byteLength > 0x7fff_ffff) {
    throw new RangeError("graph storage is too large");
  }
  return {
    offsets,
    targets,
    weights,
    distances,
    previous,
    heapPriorities,
    heapIds,
    outputId,
    outputPriority,
    byteLength,
  };
}

function validateGraph(
  offsets: Uint32Array,
  targets: Uint32Array,
  weights: Float32Array,
): void {
  if (!(offsets instanceof Uint32Array) || offsets.length < 2) {
    throw new RangeError("offsets must describe at least one node");
  }
  if (!(targets instanceof Uint32Array) || !(weights instanceof Float32Array)) {
    throw new TypeError("targets and weights must be Uint32Array and Float32Array");
  }
  if (targets.length !== weights.length || offsets[0] !== 0 || offsets.at(-1) !== targets.length) {
    throw new RangeError("invalid CSR shape");
  }
  const nodeCount = offsets.length - 1;
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index]! < offsets[index - 1]!) throw new RangeError("offsets must be monotone");
  }
  for (const target of targets) {
    if (target >= nodeCount) throw new RangeError("edge target is out of bounds");
  }
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError("Dijkstra weights must be finite and non-negative");
    }
  }
}

function nextCapacity(required: number): number {
  if (required > 0x1000_0000) throw new RangeError("priority queue capacity is too large");
  let capacity = 4;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function validatePriority(priority: number): void {
  if (!Number.isFinite(priority)) throw new RangeError("priority must be finite");
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function validateNode(value: number, nodeCount: number, name: string): void {
  validateNonNegativeInteger(value, name);
  if (value >= nodeCount) throw new RangeError(`${name} is out of bounds`);
}
