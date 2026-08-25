export interface AllocatorStats {
  readonly liveAllocations: number;
  readonly liveBytes: number;
  readonly freeBytes: number;
  readonly reservedBytes: number;
  readonly memoryBytes: number;
}

export interface Allocation {
  readonly pointer: number;
  readonly byteLength: number;
}

export class LinearMemoryAllocator {
  readonly #memory: WebAssembly.Memory;
  readonly #free = new Map<number, number[]>();
  #reservedBytes = 0;
  #liveBytes = 0;
  #liveAllocations = 0;

  constructor(memory: WebAssembly.Memory) {
    this.#memory = memory;
  }

  allocate(requestedBytes: number): Allocation {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
      throw new RangeError("allocation size must be a non-negative safe integer");
    }
    // Power-of-two classes bound fragmentation while keeping every block SIMD-aligned.
    const byteLength = requestedBytes === 0
      ? 0
      : 2 ** Math.ceil(Math.log2(Math.max(16, requestedBytes)));
    if (byteLength === 0) return { pointer: 0, byteLength: 0 };
    const free = this.#free.get(byteLength);
    const pointer = free?.pop() ?? this.#reserve(byteLength);
    new Uint8Array(this.#memory.buffer, pointer, byteLength).fill(0);
    this.#liveBytes += byteLength;
    this.#liveAllocations++;
    return { pointer, byteLength };
  }

  release(allocation: Allocation): void {
    if (allocation.byteLength === 0) return;
    const free = this.#free.get(allocation.byteLength);
    if (free) free.push(allocation.pointer);
    else this.#free.set(allocation.byteLength, [allocation.pointer]);
    this.#liveBytes -= allocation.byteLength;
    this.#liveAllocations--;
  }

  stats(): AllocatorStats {
    return Object.freeze({
      liveAllocations: this.#liveAllocations,
      liveBytes: this.#liveBytes,
      freeBytes: this.#reservedBytes - this.#liveBytes,
      reservedBytes: this.#reservedBytes,
      memoryBytes: this.#memory.buffer.byteLength,
    });
  }

  #reserve(byteLength: number): number {
    const pointer = this.#reservedBytes;
    this.#reservedBytes += byteLength;
    if (this.#reservedBytes > this.#memory.buffer.byteLength) {
      this.#memory.grow(Math.ceil((this.#reservedBytes - this.#memory.buffer.byteLength) / 65_536));
    }
    return pointer;
  }
}
