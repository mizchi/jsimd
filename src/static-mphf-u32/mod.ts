import { lookup as wasmLookup, lookup_many as wasmLookupMany, memory } from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const UINT32_LIMIT = 0x1_0000_0000;
const EMPTY_BUCKET = -0x8000_0000;
const BUCKET_TARGET_SIZE = 4;
const MAX_DISPLACEMENT = 10_000_000;
const MAX_LENGTH = 0x1000_0000;
const allocator = new LinearMemoryAllocator(memory);

interface MphfLayout {
  readonly displacements: Int32Array;
  readonly fingerprints: Uint16Array;
}

/** Mutable unique-key construction state for a frozen minimal perfect hash function. */
export class StaticMphfU32Builder {
  readonly #keys: number[] = [];
  readonly #seen = new Set<number>();

  get length(): number {
    return this.#keys.length;
  }

  add(key: number): this {
    const normalized = validateUint32(key);
    if (this.#seen.has(normalized)) throw new RangeError("MPHF keys must be unique");
    this.#seen.add(normalized);
    this.#keys.push(normalized);
    return this;
  }

  freeze(): StaticMphfU32 {
    return StaticMphfU32.fromUint32Array(Uint32Array.from(this.#keys));
  }
}

/** A frozen minimal perfect hash over a known set of unsigned 32-bit keys. */
export class StaticMphfU32 {
  readonly length: number;
  readonly bucketCount: number;
  readonly fingerprintBits = 16;
  readonly encodedBytes: number;
  readonly #allocation: Allocation;
  readonly #fingerprintOffset: number;
  #disposed = false;

  private constructor(layout: MphfLayout) {
    this.length = layout.fingerprints.length;
    this.bucketCount = layout.displacements.length;
    this.#fingerprintOffset = layout.displacements.byteLength;
    this.encodedBytes = this.#fingerprintOffset + layout.fingerprints.byteLength;
    const allocation = allocator.allocate(this.encodedBytes);
    try {
      new Int32Array(
        memory.buffer,
        allocation.pointer,
        layout.displacements.length,
      ).set(layout.displacements);
      new Uint16Array(
        memory.buffer,
        allocation.pointer + this.#fingerprintOffset,
        layout.fingerprints.length,
      ).set(layout.fingerprints);
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  static from(keys: Iterable<number>): StaticMphfU32 {
    const builder = new StaticMphfU32Builder();
    for (const key of keys) builder.add(key);
    return builder.freeze();
  }

  static fromUint32Array(keys: Uint32Array): StaticMphfU32 {
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    validateLength(keys.length);
    const seen = new Set<number>();
    for (const key of keys) {
      if (seen.has(key)) throw new RangeError("MPHF keys must be unique");
      seen.add(key);
    }
    return new StaticMphfU32(buildLayout(keys));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  /** Returns a dense implementation-defined ID, or `-1` on fingerprint mismatch. */
  lookup(key: number): number {
    this.#assertAlive();
    const normalized = validateUint32(key);
    if (this.length === 0) return -1;
    return wasmLookup(...this.#lookupBase(), normalized);
  }

  /** Probabilistic membership: unknown keys have a 1 / 2^16 false-positive chance after routing. */
  has(key: number): boolean {
    return this.lookup(key) >= 0;
  }

  lookupMany(keys: Uint32Array, output: Int32Array): number {
    this.#assertAlive();
    if (!(keys instanceof Uint32Array)) throw new TypeError("keys must be a Uint32Array");
    if (!(output instanceof Int32Array) || output.length < keys.length) {
      throw new RangeError("output must be an Int32Array covering every query");
    }
    if (keys.length === 0) return 0;
    if (this.length === 0) {
      output.fill(-1, 0, keys.length);
      return 0;
    }
    const scratch = allocator.allocate(keys.byteLength + keys.byteLength);
    const outputPointer = scratch.pointer + keys.byteLength;
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const found = wasmLookupMany(
        ...this.#lookupBase(),
        scratch.pointer,
        keys.length,
        outputPointer,
      );
      output.set(new Int32Array(memory.buffer, outputPointer, keys.length));
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #lookupBase(): [number, number, number, number] {
    return [
      this.#allocation.pointer,
      this.#allocation.pointer + this.#fingerprintOffset,
      this.bucketCount,
      this.length,
    ];
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("StaticMphfU32 has been disposed");
  }
}

function buildLayout(keys: Uint32Array): MphfLayout {
  if (keys.length === 0) {
    return { displacements: new Int32Array(), fingerprints: new Uint16Array() };
  }
  const bucketCount = Math.ceil(keys.length / BUCKET_TARGET_SIZE);
  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  for (const key of keys) buckets[mix32(key) % bucketCount]!.push(key);

  const displacements = new Int32Array(bucketCount).fill(EMPTY_BUCKET);
  const fingerprints = new Uint16Array(keys.length);
  const used = new Uint8Array(keys.length);
  const keyAtSlot = new Uint32Array(keys.length);
  const multipleBuckets = buckets
    .map((keys, index) => ({ keys, index }))
    .filter((bucket) => bucket.keys.length > 1)
    .sort((left, right) => right.keys.length - left.keys.length);

  for (const bucket of multipleBuckets) {
    const slots = new Uint32Array(bucket.keys.length);
    let displacement = 1;
    for (; displacement <= MAX_DISPLACEMENT; displacement++) {
      let valid = true;
      for (let index = 0; index < bucket.keys.length; index++) {
        const slot = displacedSlot(bucket.keys[index]!, displacement, keys.length);
        if (used[slot] !== 0) {
          valid = false;
          break;
        }
        for (let previous = 0; previous < index; previous++) {
          if (slots[previous] === slot) {
            valid = false;
            break;
          }
        }
        if (!valid) break;
        slots[index] = slot;
      }
      if (valid) break;
    }
    if (displacement > MAX_DISPLACEMENT) {
      throw new Error("unable to construct MPHF within the displacement search limit");
    }
    displacements[bucket.index] = displacement;
    for (let index = 0; index < bucket.keys.length; index++) {
      const slot = slots[index]!;
      used[slot] = 1;
      keyAtSlot[slot] = bucket.keys[index]!;
    }
  }

  let freeSlot = 0;
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const bucket = buckets[bucketIndex]!;
    if (bucket.length !== 1) continue;
    while (used[freeSlot] !== 0) freeSlot++;
    displacements[bucketIndex] = -(freeSlot + 1);
    used[freeSlot] = 1;
    keyAtSlot[freeSlot] = bucket[0]!;
  }

  for (let slot = 0; slot < keyAtSlot.length; slot++) {
    fingerprints[slot] = fingerprint(keyAtSlot[slot]!);
  }
  return { displacements, fingerprints };
}

function displacedSlot(key: number, displacement: number, length: number): number {
  return mix32((key ^ Math.imul(displacement, 0x9e37_79b9)) >>> 0) % length;
}

function fingerprint(key: number): number {
  return mix32((key ^ 0xa5a5_a5a5) >>> 0) & 0xffff;
}

function mix32(value: number): number {
  let hash = (value ^ (value >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x7feb_352d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x846c_a68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_LIMIT) {
    throw new RangeError("MPHF keys must be unsigned 32-bit integers");
  }
  return value;
}

function validateLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LENGTH) {
    throw new RangeError("too many MPHF keys");
  }
}
