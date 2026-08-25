import {
  array_array_and_into as wasmArrayArrayAndInto,
  array_array_count as wasmArrayArrayCount,
  array_array_intersects as wasmArrayArrayIntersects,
  array_bitmap_and_into as wasmArrayBitmapAndInto,
  array_bitmap_count as wasmArrayBitmapCount,
  array_bitmap_intersects as wasmArrayBitmapIntersects,
  bitmap_and_count as wasmBitmapAndCount,
  bitmap_and_into as wasmBitmapAndInto,
  bitmap_intersects as wasmBitmapIntersects,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const ARRAY_LIMIT = 4_096;
const BITMAP_WORDS = 2_048;
const BITMAP_BYTES = BITMAP_WORDS * 4;
const allocator = new LinearMemoryAllocator(memory);

interface ArrayContainer {
  readonly kind: "array";
  readonly key: number;
  allocation: Allocation;
  length: number;
  capacity: number;
}

interface BitmapContainer {
  readonly kind: "bitmap";
  readonly key: number;
  readonly allocation: Allocation;
  cardinality: number;
}

type Container = ArrayContainer | BitmapContainer;

/** A mutable Roaring-style set for unsigned 32-bit integer keys. */
export class RoaringBitmap {
  readonly #containers: Container[] = [];
  #size = 0;
  #disposed = false;

  static from(values: Iterable<number>): RoaringBitmap {
    const result = new RoaringBitmap();
    try {
      for (const value of values) result.insert(value);
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get size(): number {
    this.#assertAlive();
    return this.#size;
  }

  has(value: number): boolean {
    const normalized = validateValue(value);
    this.#assertAlive();
    const key = Math.floor(normalized / 65_536);
    const low = normalized & 0xffff;
    const found = this.#findContainer(key);
    if (!found.found) return false;
    const container = this.#containers[found.index]!;
    if (container.kind === "array") {
      const values = this.#arrayView(container);
      const index = lowerBound(values, container.length, low);
      return index < container.length && values[index] === low;
    }
    return (this.#bitmapView(container)[low >>> 5]! & (1 << (low & 31))) !== 0;
  }

  insert(value: number): this {
    const normalized = validateValue(value);
    this.#assertAlive();
    const key = Math.floor(normalized / 65_536);
    const low = normalized & 0xffff;
    const found = this.#findContainer(key);
    if (!found.found) {
      const container = this.#allocateArray(key, 1);
      this.#arrayView(container)[0] = low;
      container.length = 1;
      this.#containers.splice(found.index, 0, container);
      this.#size++;
      return this;
    }

    const container = this.#containers[found.index]!;
    if (container.kind === "bitmap") {
      const words = this.#bitmapView(container);
      const wordIndex = low >>> 5;
      const mask = 1 << (low & 31);
      if ((words[wordIndex]! & mask) !== 0) return this;
      words[wordIndex] = (words[wordIndex]! | mask) >>> 0;
      container.cardinality++;
      this.#size++;
      return this;
    }

    let values = this.#arrayView(container);
    const index = lowerBound(values, container.length, low);
    if (index < container.length && values[index] === low) return this;
    if (container.length === ARRAY_LIMIT) {
      const bitmap = this.#arrayToBitmap(container);
      const words = this.#bitmapView(bitmap);
      words[low >>> 5] = (words[low >>> 5]! | (1 << (low & 31))) >>> 0;
      bitmap.cardinality++;
      this.#containers[found.index] = bitmap;
      this.#size++;
      return this;
    }
    if (container.length === container.capacity) {
      this.#growArray(container);
      values = this.#arrayView(container);
    }
    values.copyWithin(index + 1, index, container.length);
    values[index] = low;
    container.length++;
    this.#size++;
    return this;
  }

  remove(value: number): this {
    const normalized = validateValue(value);
    this.#assertAlive();
    const key = Math.floor(normalized / 65_536);
    const low = normalized & 0xffff;
    const found = this.#findContainer(key);
    if (!found.found) return this;
    const container = this.#containers[found.index]!;
    if (container.kind === "array") {
      const values = this.#arrayView(container);
      const index = lowerBound(values, container.length, low);
      if (index >= container.length || values[index] !== low) return this;
      values.copyWithin(index, index + 1, container.length);
      container.length--;
      this.#size--;
      if (container.length === 0) {
        allocator.release(container.allocation);
        this.#containers.splice(found.index, 1);
      }
      return this;
    }

    const words = this.#bitmapView(container);
    const wordIndex = low >>> 5;
    const mask = 1 << (low & 31);
    if ((words[wordIndex]! & mask) === 0) return this;
    words[wordIndex] = (words[wordIndex]! & ~mask) >>> 0;
    container.cardinality--;
    this.#size--;
    if (container.cardinality === ARRAY_LIMIT) {
      this.#containers[found.index] = this.#bitmapToArray(container);
    }
    return this;
  }

  clear(): this {
    this.#assertAlive();
    this.#clearContainers();
    return this;
  }

  andCardinality(other: RoaringBitmap): number {
    this.#checkOther(other);
    let leftIndex = 0;
    let rightIndex = 0;
    let count = 0;
    while (leftIndex < this.#containers.length && rightIndex < other.#containers.length) {
      const left = this.#containers[leftIndex]!;
      const right = other.#containers[rightIndex]!;
      if (left.key < right.key) leftIndex++;
      else if (left.key > right.key) rightIndex++;
      else {
        count += this.#containerAndCardinality(left, right);
        leftIndex++;
        rightIndex++;
      }
    }
    return count;
  }

  intersects(other: RoaringBitmap): boolean {
    this.#checkOther(other);
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < this.#containers.length && rightIndex < other.#containers.length) {
      const left = this.#containers[leftIndex]!;
      const right = other.#containers[rightIndex]!;
      if (left.key < right.key) leftIndex++;
      else if (left.key > right.key) rightIndex++;
      else {
        if (this.#containersIntersect(left, right)) return true;
        leftIndex++;
        rightIndex++;
      }
    }
    return false;
  }

  jaccard(other: RoaringBitmap): number {
    this.#checkOther(other);
    const intersection = this.andCardinality(other);
    const union = this.#size + other.#size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  and(other: RoaringBitmap): RoaringBitmap {
    const output = new RoaringBitmap();
    try {
      return this.andInto(other, output);
    } catch (error) {
      output.dispose();
      throw error;
    }
  }

  andInto(other: RoaringBitmap, output: RoaringBitmap): RoaringBitmap {
    this.#checkOther(other);
    output.#assertAlive();
    if (output === this || output === other) {
      throw new RangeError("output must not alias either input set");
    }
    output.#clearContainers();
    let leftIndex = 0;
    let rightIndex = 0;
    try {
      while (leftIndex < this.#containers.length && rightIndex < other.#containers.length) {
        const left = this.#containers[leftIndex]!;
        const right = other.#containers[rightIndex]!;
        if (left.key < right.key) leftIndex++;
        else if (left.key > right.key) rightIndex++;
        else {
          const result = output.#intersectContainers(left, right);
          if (result !== undefined) {
            output.#containers.push(result);
            output.#size += containerCardinality(result);
          }
          leftIndex++;
          rightIndex++;
        }
      }
      return output;
    } catch (error) {
      output.#clearContainers();
      throw error;
    }
  }

  toUint32Array(): Uint32Array {
    this.#assertAlive();
    const output = new Uint32Array(this.#size);
    let index = 0;
    this.#forEachValue((value) => {
      output[index++] = value;
    });
    return output;
  }

  forEachRange(callback: (start: number, end: number) => void): void {
    this.#assertAlive();
    let start = -1;
    let previous = -1;
    this.#forEachValue((value) => {
      if (start < 0) {
        start = value;
      } else if (value !== previous + 1) {
        callback(start, previous);
        start = value;
      }
      previous = value;
    });
    if (start >= 0) callback(start, previous);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#clearContainers();
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("RoaringBitmap has been disposed");
  }

  #checkOther(other: RoaringBitmap): void {
    this.#assertAlive();
    other.#assertAlive();
  }

  #findContainer(key: number): { index: number; found: boolean } {
    let low = 0;
    let high = this.#containers.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#containers[middle]!.key < key) low = middle + 1;
      else high = middle;
    }
    return {
      index: low,
      found: low < this.#containers.length && this.#containers[low]!.key === key,
    };
  }

  #allocateArray(key: number, requestedCapacity: number): ArrayContainer {
    const allocation = allocator.allocate(Math.max(1, requestedCapacity) * 2);
    return {
      kind: "array",
      key,
      allocation,
      length: 0,
      capacity: Math.min(ARRAY_LIMIT, allocation.byteLength / 2),
    };
  }

  #allocateBitmap(key: number): BitmapContainer {
    return { kind: "bitmap", key, allocation: allocator.allocate(BITMAP_BYTES), cardinality: 0 };
  }

  #growArray(container: ArrayContainer): void {
    const allocation = allocator.allocate(Math.min(ARRAY_LIMIT, container.capacity * 2) * 2);
    new Uint16Array(memory.buffer, allocation.pointer, allocation.byteLength / 2).set(
      this.#arrayView(container).subarray(0, container.length),
    );
    allocator.release(container.allocation);
    container.allocation = allocation;
    container.capacity = Math.min(ARRAY_LIMIT, allocation.byteLength / 2);
  }

  #arrayToBitmap(container: ArrayContainer): BitmapContainer {
    const result = this.#allocateBitmap(container.key);
    const source = this.#arrayView(container);
    const target = this.#bitmapView(result);
    for (let index = 0; index < container.length; index++) {
      const value = source[index]!;
      target[value >>> 5] = (target[value >>> 5]! | (1 << (value & 31))) >>> 0;
    }
    result.cardinality = container.length;
    allocator.release(container.allocation);
    return result;
  }

  #bitmapToArray(container: BitmapContainer): ArrayContainer {
    const result = this.#allocateArray(container.key, container.cardinality);
    const source = this.#bitmapView(container);
    const target = this.#arrayView(result);
    let outputIndex = 0;
    for (let wordIndex = 0; wordIndex < BITMAP_WORDS; wordIndex++) {
      let word = source[wordIndex]!;
      while (word !== 0) {
        const lowest = word & -word;
        target[outputIndex++] = wordIndex * 32 + 31 - Math.clz32(lowest);
        word = (word & (word - 1)) >>> 0;
      }
    }
    result.length = outputIndex;
    allocator.release(container.allocation);
    return result;
  }

  #intersectContainers(left: Container, right: Container): Container | undefined {
    if (left.kind === "bitmap" && right.kind === "bitmap") {
      const result = this.#allocateBitmap(left.key);
      result.cardinality = wasmBitmapAndInto(
        left.allocation.pointer,
        right.allocation.pointer,
        result.allocation.pointer,
      );
      if (result.cardinality === 0) {
        allocator.release(result.allocation);
        return undefined;
      }
      return result.cardinality <= ARRAY_LIMIT ? this.#bitmapToArray(result) : result;
    }

    if (left.kind === "array" && right.kind === "array") {
      const result = this.#allocateArray(left.key, Math.min(left.length, right.length));
      result.length = wasmArrayArrayAndInto(
        left.allocation.pointer,
        left.length,
        right.allocation.pointer,
        right.length,
        result.allocation.pointer,
      );
      if (result.length === 0) {
        allocator.release(result.allocation);
        return undefined;
      }
      return result;
    }

    const array = left.kind === "array" ? left : right as ArrayContainer;
    const bitmap = left.kind === "bitmap" ? left : right as BitmapContainer;
    const result = this.#allocateArray(left.key, array.length);
    result.length = wasmArrayBitmapAndInto(
      array.allocation.pointer,
      array.length,
      bitmap.allocation.pointer,
      result.allocation.pointer,
    );
    if (result.length === 0) {
      allocator.release(result.allocation);
      return undefined;
    }
    return result;
  }

  #containerAndCardinality(left: Container, right: Container): number {
    if (left.kind === "bitmap" && right.kind === "bitmap") {
      return wasmBitmapAndCount(left.allocation.pointer, right.allocation.pointer);
    }
    if (left.kind === "array" && right.kind === "array") {
      return wasmArrayArrayCount(
        left.allocation.pointer,
        left.length,
        right.allocation.pointer,
        right.length,
      );
    }
    const array = left.kind === "array" ? left : right as ArrayContainer;
    const bitmap = left.kind === "bitmap" ? left : right as BitmapContainer;
    return wasmArrayBitmapCount(
      array.allocation.pointer,
      array.length,
      bitmap.allocation.pointer,
    );
  }

  #containersIntersect(left: Container, right: Container): boolean {
    if (left.kind === "bitmap" && right.kind === "bitmap") {
      return wasmBitmapIntersects(left.allocation.pointer, right.allocation.pointer) !== 0;
    }
    if (left.kind === "array" && right.kind === "array") {
      return wasmArrayArrayIntersects(
        left.allocation.pointer,
        left.length,
        right.allocation.pointer,
        right.length,
      ) !== 0;
    }
    const array = left.kind === "array" ? left : right as ArrayContainer;
    const bitmap = left.kind === "bitmap" ? left : right as BitmapContainer;
    return wasmArrayBitmapIntersects(
      array.allocation.pointer,
      array.length,
      bitmap.allocation.pointer,
    ) !== 0;
  }

  #arrayView(container: ArrayContainer): Uint16Array {
    return new Uint16Array(memory.buffer, container.allocation.pointer, container.capacity);
  }

  #bitmapView(container: BitmapContainer): Uint32Array {
    return new Uint32Array(memory.buffer, container.allocation.pointer, BITMAP_WORDS);
  }

  #forEachValue(callback: (value: number) => void): void {
    for (const container of this.#containers) {
      const base = container.key * 65_536;
      if (container.kind === "array") {
        const values = this.#arrayView(container);
        for (let index = 0; index < container.length; index++) callback(base + values[index]!);
      } else {
        const words = this.#bitmapView(container);
        for (let wordIndex = 0; wordIndex < BITMAP_WORDS; wordIndex++) {
          let word = words[wordIndex]!;
          while (word !== 0) {
            const lowest = word & -word;
            callback(base + wordIndex * 32 + 31 - Math.clz32(lowest));
            word = (word & (word - 1)) >>> 0;
          }
        }
      }
    }
  }

  #clearContainers(): void {
    for (const container of this.#containers) allocator.release(container.allocation);
    this.#containers.length = 0;
    this.#size = 0;
  }
}

/** @deprecated Use `RoaringBitmap`. */
export { RoaringBitmap as RoaringUint32Set };

function lowerBound(values: Uint16Array, length: number, target: number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function containerCardinality(container: Container): number {
  return container.kind === "array" ? container.length : container.cardinality;
}

function validateValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
  return value;
}
