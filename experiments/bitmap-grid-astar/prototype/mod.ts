import {
  astar_scalar as wasmAstarScalar,
  astar_simd as wasmAstarSimd,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../../../src/internal/allocator.ts";

const allocator = new LinearMemoryAllocator(memory);
const U32_BYTES = 4;

type AstarKernel = typeof wasmAstarSimd;

export interface GridPathResult {
  readonly distance: number;
  readonly path: Uint32Array;
}

/** Experimental four-neighbor A* over a one-bit-per-cell immutable obstacle grid. */
export class BitmapGridAStar implements Disposable {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly residentBytes: number;
  readonly #layout: Layout;
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(width: number, height: number, words: Uint32Array) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.#layout = createLayout(this.cellCount, words.length);
    this.residentBytes = this.#layout.byteLength;
    this.#allocation = allocator.allocate(this.residentBytes);
    try {
      this.#words().set(words);
    } catch (error) {
      allocator.release(this.#allocation);
      throw error;
    }
  }

  static fromObstacles(
    width: number,
    height: number,
    blocked: Uint8Array,
  ): BitmapGridAStar {
    const cellCount = validateDimensions(width, height);
    if (!(blocked instanceof Uint8Array) || blocked.length !== cellCount) {
      throw new RangeError("blocked bytes must cover every grid cell");
    }
    const words = new Uint32Array(Math.ceil(cellCount / 32));
    for (let index = 0; index < cellCount; index++) {
      if (blocked[index] !== 0) words[index >>> 5] |= 1 << (index & 31);
    }
    return new BitmapGridAStar(width, height, words);
  }

  static fromBitmap(
    width: number,
    height: number,
    blockedWords: Uint32Array,
  ): BitmapGridAStar {
    const cellCount = validateDimensions(width, height);
    const wordCount = Math.ceil(cellCount / 32);
    if (!(blockedWords instanceof Uint32Array) || blockedWords.length !== wordCount) {
      throw new RangeError("blocked words must cover every grid cell");
    }
    const words = blockedWords.slice();
    const tailBits = cellCount & 31;
    if (tailBits !== 0) words[wordCount - 1]! &= 0xffff_ffff >>> (32 - tailBits);
    return new BitmapGridAStar(width, height, words);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  isBlocked(x: number, y: number): boolean {
    const node = this.#node(x, y);
    return (this.#words()[node >>> 5]! & 1 << (node & 31)) !== 0;
  }

  findPath(startX: number, startY: number, targetX: number, targetY: number): GridPathResult {
    return this.#findPath(startX, startY, targetX, targetY, wasmAstarScalar);
  }

  findPathSimd(
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
  ): GridPathResult {
    return this.#findPath(startX, startY, targetX, targetY, wasmAstarSimd);
  }

  findPathScalar(
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
  ): GridPathResult {
    return this.findPath(startX, startY, targetX, targetY);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #findPath(
    startX: number,
    startY: number,
    targetX: number,
    targetY: number,
    kernel: AstarKernel,
  ): GridPathResult {
    const start = this.#node(startX, startY);
    const target = this.#node(targetX, targetY);
    if (this.#blockedNode(start) || this.#blockedNode(target)) {
      throw new RangeError("path endpoints must be open cells");
    }
    const base = this.#allocation.pointer;
    const rawDistance = kernel(
      base + this.#layout.walls,
      this.width,
      this.height,
      start,
      target,
      base + this.#layout.distances,
      base + this.#layout.previous,
      base + this.#layout.heapPriorities,
      base + this.#layout.heapIds,
      base + this.#layout.outputId,
      base + this.#layout.outputPriority,
    );
    if (rawDistance === -1) return { distance: Infinity, path: new Uint32Array() };
    const previous = this.#uint32(this.#layout.previous, this.cellCount);
    const reversed: number[] = [];
    let cursor = target;
    for (let count = 0; count <= this.cellCount; count++) {
      reversed.push(cursor);
      if (cursor === start) break;
      cursor = previous[cursor]!;
      if (cursor === 0xffff_ffff) throw new Error("invalid predecessor chain");
    }
    if (reversed.at(-1) !== start) throw new Error("predecessor cycle");
    reversed.reverse();
    return { distance: rawDistance, path: Uint32Array.from(reversed) };
  }

  #node(x: number, y: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      throw new RangeError("grid coordinates must be integers");
    }
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      throw new RangeError("grid coordinate is out of bounds");
    }
    return y * this.width + x;
  }

  #blockedNode(node: number): boolean {
    return (this.#words()[node >>> 5]! & 1 << (node & 31)) !== 0;
  }

  #words(): Uint32Array {
    return this.#uint32(this.#layout.walls, this.#layout.wallWords);
  }

  #uint32(relativeOffset: number, length: number): Uint32Array {
    return new Uint32Array(memory.buffer, this.#allocation.pointer + relativeOffset, length);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitmapGridAStar has been disposed");
  }
}

interface Layout {
  readonly walls: number;
  readonly wallWords: number;
  readonly distances: number;
  readonly previous: number;
  readonly heapPriorities: number;
  readonly heapIds: number;
  readonly outputId: number;
  readonly outputPriority: number;
  readonly byteLength: number;
}

function createLayout(cellCount: number, wallWords: number): Layout {
  const walls = 0;
  const distances = walls + wallWords * U32_BYTES;
  const previous = distances + cellCount * U32_BYTES;
  const heapCapacity = cellCount * 4 + 1;
  const heapPriorities = previous + cellCount * U32_BYTES;
  const heapIds = heapPriorities + heapCapacity * U32_BYTES;
  const outputId = heapIds + heapCapacity * U32_BYTES;
  const outputPriority = outputId + U32_BYTES;
  const byteLength = outputPriority + U32_BYTES;
  if (!Number.isSafeInteger(byteLength) || byteLength > 0x7fff_ffff) {
    throw new RangeError("grid storage is too large");
  }
  return {
    walls,
    wallWords,
    distances,
    previous,
    heapPriorities,
    heapIds,
    outputId,
    outputPriority,
    byteLength,
  };
}

function validateDimensions(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("grid dimensions must be positive safe integers");
  }
  const cellCount = width * height;
  const tieScale = width + height;
  if (
    !Number.isSafeInteger(cellCount) || cellCount > 0x1fff_ffff ||
    (cellCount + tieScale) * tieScale > 0xffff_ffff
  ) {
    throw new RangeError("grid dimensions exceed the priority encoding");
  }
  return cellCount;
}
