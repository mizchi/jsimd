import {
  lookup as wasmLookup,
  lookup_many as wasmLookupMany,
  lookup_values_many as wasmLookupValuesMany,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const EMPTY_BUCKET = -0x8000_0000;
const BUCKET_TARGET_SIZE = 4;
const MAX_DISPLACEMENT = 10_000_000;
const MAX_LENGTH = 0x1000_0000;
const allocator = new LinearMemoryAllocator(memory);

interface KeyBatch {
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
}

interface MphfLayout {
  readonly displacements: Int32Array;
  readonly offsets: Uint32Array;
  readonly lengths: Uint32Array;
  readonly arena: Uint8Array;
  readonly inputSlots: Uint32Array;
}

class MphfStorage {
  readonly length: number;
  readonly bucketCount: number;
  readonly encodedBytes: number;
  readonly displacements: Allocation;
  readonly offsets: Allocation;
  readonly lengths: Allocation;
  readonly arena: Allocation;
  #disposed = false;

  constructor(layout: MphfLayout) {
    this.length = layout.offsets.length;
    this.bucketCount = layout.displacements.length;
    this.encodedBytes = layout.displacements.byteLength + layout.offsets.byteLength +
      layout.lengths.byteLength + layout.arena.byteLength;
    let displacements: Allocation | undefined;
    let offsets: Allocation | undefined;
    let lengths: Allocation | undefined;
    let arena: Allocation | undefined;
    try {
      displacements = allocator.allocate(layout.displacements.byteLength);
      offsets = allocator.allocate(layout.offsets.byteLength);
      lengths = allocator.allocate(layout.lengths.byteLength);
      arena = allocator.allocate(layout.arena.byteLength);
      new Int32Array(memory.buffer, displacements.pointer, layout.displacements.length).set(
        layout.displacements,
      );
      new Uint32Array(memory.buffer, offsets.pointer, layout.offsets.length).set(layout.offsets);
      new Uint32Array(memory.buffer, lengths.pointer, layout.lengths.length).set(layout.lengths);
      new Uint8Array(memory.buffer, arena.pointer, layout.arena.length).set(layout.arena);
    } catch (error) {
      if (arena !== undefined) allocator.release(arena);
      if (lengths !== undefined) allocator.release(lengths);
      if (offsets !== undefined) allocator.release(offsets);
      if (displacements !== undefined) allocator.release(displacements);
      throw error;
    }
    this.displacements = displacements;
    this.offsets = offsets;
    this.lengths = lengths;
    this.arena = arena;
  }

  lookup(key: Uint8Array): number {
    this.assertAlive();
    validateKey(key);
    if (this.length === 0) return -1;
    const scratch = allocator.allocate(key.length);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, key.length).set(key);
      return wasmLookup(...this.base(), scratch.pointer, key.length);
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(bytes: Uint8Array, queryOffsets: Uint32Array, output: Int32Array): number {
    this.assertAlive();
    const count = validateBatch(bytes, queryOffsets);
    if (!(output instanceof Int32Array) || output.length < count) {
      throw new RangeError("output must cover every query");
    }
    if (count === 0) return 0;
    if (this.length === 0) {
      output.fill(-1, 0, count);
      return 0;
    }
    const offsetsOffset = align4(bytes.byteLength);
    const outputOffset = offsetsOffset + queryOffsets.byteLength;
    const scratch = allocator.allocate(outputOffset + count * 4);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, bytes.length).set(bytes);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, queryOffsets.length).set(
        queryOffsets,
      );
      const found = wasmLookupMany(
        ...this.base(),
        scratch.pointer,
        scratch.pointer + offsetsOffset,
        count,
        scratch.pointer + outputOffset,
      );
      output.set(new Int32Array(memory.buffer, scratch.pointer + outputOffset, count), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupValuesMany(
    valuesPointer: number,
    bytes: Uint8Array,
    queryOffsets: Uint32Array,
    output: Uint32Array,
    present: Uint8Array,
  ): number {
    this.assertAlive();
    const count = validateBatch(bytes, queryOffsets);
    if (!(output instanceof Uint32Array) || output.length < count) {
      throw new RangeError("output must cover every query");
    }
    if (!(present instanceof Uint8Array) || present.length < count) {
      throw new RangeError("present must cover every query");
    }
    if (count === 0) return 0;
    const offsetsOffset = align4(bytes.byteLength);
    const outputOffset = offsetsOffset + queryOffsets.byteLength;
    const presentOffset = outputOffset + count * 4;
    const scratch = allocator.allocate(presentOffset + count);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, bytes.length).set(bytes);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, queryOffsets.length).set(
        queryOffsets,
      );
      const found = wasmLookupValuesMany(
        ...this.base(),
        valuesPointer,
        scratch.pointer,
        scratch.pointer + offsetsOffset,
        count,
        scratch.pointer + outputOffset,
        scratch.pointer + presentOffset,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer + outputOffset, count), 0);
      present.set(new Uint8Array(memory.buffer, scratch.pointer + presentOffset, count), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  base(): [number, number, number, number, number, number] {
    this.assertAlive();
    return [
      this.displacements.pointer,
      this.bucketCount,
      this.offsets.pointer,
      this.lengths.pointer,
      this.length,
      this.arena.pointer,
    ];
  }

  assertAlive(): void {
    if (this.#disposed) throw new Error("StaticMphfBytes has been disposed");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.arena);
    allocator.release(this.lengths);
    allocator.release(this.offsets);
    allocator.release(this.displacements);
  }
}

/** Mutable unique-key construction state for an exact frozen byte-key MPHF. */
export class StaticMphfBytesBuilder {
  readonly #keys: Uint8Array[] = [];
  readonly #seen = new Set<string>();

  get length(): number {
    return this.#keys.length;
  }

  add(key: Uint8Array): this {
    validateKey(key);
    const identity = keyIdentity(key);
    if (this.#seen.has(identity)) throw new RangeError("MPHF keys must be unique");
    this.#seen.add(identity);
    this.#keys.push(key.slice());
    return this;
  }

  freeze(): StaticMphfBytes {
    const batch = flattenKeys(this.#keys);
    return StaticMphfBytes.fromBytes(batch.bytes, batch.offsets);
  }
}

/** A frozen minimal perfect hash with exact byte-key membership verification. */
export class StaticMphfBytes {
  readonly #storage: MphfStorage;

  private constructor(layout: MphfLayout) {
    this.#storage = new MphfStorage(layout);
  }

  static from(keys: Iterable<Uint8Array>): StaticMphfBytes {
    const builder = new StaticMphfBytesBuilder();
    for (const key of keys) builder.add(key);
    return builder.freeze();
  }

  static fromBytes(bytes: Uint8Array, offsets: Uint32Array): StaticMphfBytes {
    validateUniqueBatch(bytes, offsets);
    return new StaticMphfBytes(buildLayout(bytes, offsets));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get length(): number {
    return this.#storage.length;
  }

  get bucketCount(): number {
    return this.#storage.bucketCount;
  }

  get encodedBytes(): number {
    return this.#storage.encodedBytes;
  }

  lookup(key: Uint8Array): number {
    return this.#storage.lookup(key);
  }

  has(key: Uint8Array): boolean {
    return this.lookup(key) >= 0;
  }

  lookupMany(bytes: Uint8Array, offsets: Uint32Array, output: Int32Array): number {
    return this.#storage.lookupMany(bytes, offsets, output);
  }

  [Symbol.dispose](): void {
    this.#storage.dispose();
  }
}

/** An exact frozen byte-key map with Uint32 values stored in MPHF slot order. */
export class FrozenByteMapU32 {
  readonly #storage: MphfStorage;
  readonly #values: Allocation;
  #disposed = false;

  private constructor(layout: MphfLayout, inputValues: Uint32Array) {
    this.#storage = new MphfStorage(layout);
    try {
      this.#values = allocator.allocate(inputValues.byteLength);
      const values = new Uint32Array(memory.buffer, this.#values.pointer, inputValues.length);
      for (let input = 0; input < inputValues.length; input++) {
        values[layout.inputSlots[input]!] = inputValues[input]!;
      }
    } catch (error) {
      this.#storage.dispose();
      throw error;
    }
  }

  static from(entries: Iterable<readonly [Uint8Array, number]>): FrozenByteMapU32 {
    const keys: Uint8Array[] = [];
    const values: number[] = [];
    for (const [key, value] of entries) {
      validateKey(key);
      keys.push(key.slice());
      values.push(validateUint32(value));
    }
    const batch = flattenKeys(keys);
    return FrozenByteMapU32.fromBytes(batch.bytes, batch.offsets, Uint32Array.from(values));
  }

  static fromBytes(
    bytes: Uint8Array,
    offsets: Uint32Array,
    values: Uint32Array,
  ): FrozenByteMapU32 {
    const count = validateUniqueBatch(bytes, offsets);
    if (!(values instanceof Uint32Array) || values.length !== count) {
      throw new RangeError("values must contain one Uint32 for every key");
    }
    return new FrozenByteMapU32(buildLayout(bytes, offsets), values);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get size(): number {
    this.#assertAlive();
    return this.#storage.length;
  }

  get encodedBytes(): number {
    this.#assertAlive();
    return this.#storage.encodedBytes + this.#storage.length * 4;
  }

  get(key: Uint8Array): number | undefined {
    this.#assertAlive();
    const slot = this.#storage.lookup(key);
    if (slot < 0) return undefined;
    return new Uint32Array(memory.buffer, this.#values.pointer, this.#storage.length)[slot]!;
  }

  has(key: Uint8Array): boolean {
    return this.get(key) !== undefined;
  }

  lookupMany(
    bytes: Uint8Array,
    offsets: Uint32Array,
    output: Uint32Array,
    present: Uint8Array,
  ): number {
    this.#assertAlive();
    return this.#storage.lookupValuesMany(this.#values.pointer, bytes, offsets, output, present);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#values);
    this.#storage.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FrozenByteMapU32 has been disposed");
  }
}

function buildLayout(bytes: Uint8Array, offsets: Uint32Array): MphfLayout {
  const count = validateBatch(bytes, offsets);
  if (count === 0) {
    return {
      displacements: new Int32Array(),
      offsets: new Uint32Array(),
      lengths: new Uint32Array(),
      arena: bytes.slice(),
      inputSlots: new Uint32Array(),
    };
  }
  const bucketCount = Math.ceil(count / BUCKET_TARGET_SIZE);
  const hashes1 = new Uint32Array(count);
  const hashes2 = new Uint32Array(count);
  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  for (let input = 0; input < count; input++) {
    const start = offsets[input]!;
    const end = offsets[input + 1]!;
    const key = bytes.subarray(start, end);
    hashes1[input] = hashBytes(key, 0x811c_9dc5, 0x0100_0193, 0);
    hashes2[input] = hashBytes(key, 0x9e37_79b9, 0x27d4_eb2d, 13);
    buckets[hashes1[input]! % bucketCount]!.push(input);
  }

  const displacements = new Int32Array(bucketCount).fill(EMPTY_BUCKET);
  const used = new Uint8Array(count);
  const inputAtSlot = new Int32Array(count).fill(-1);
  const inputSlots = new Uint32Array(count);
  const multipleBuckets = buckets
    .map((inputs, index) => ({ inputs, index }))
    .filter((bucket) => bucket.inputs.length > 1)
    .sort((left, right) => right.inputs.length - left.inputs.length);

  for (const bucket of multipleBuckets) {
    const slots = new Uint32Array(bucket.inputs.length);
    let displacement = 1;
    for (; displacement <= MAX_DISPLACEMENT; displacement++) {
      let valid = true;
      for (let index = 0; index < bucket.inputs.length; index++) {
        const slot = displacedSlot(hashes2[bucket.inputs[index]!]!, displacement, count);
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
      throw new Error("unable to construct byte MPHF within the displacement search limit");
    }
    displacements[bucket.index] = displacement;
    for (let index = 0; index < bucket.inputs.length; index++) {
      const input = bucket.inputs[index]!;
      const slot = slots[index]!;
      used[slot] = 1;
      inputAtSlot[slot] = input;
      inputSlots[input] = slot;
    }
  }

  let freeSlot = 0;
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const bucket = buckets[bucketIndex]!;
    if (bucket.length !== 1) continue;
    while (used[freeSlot] !== 0) freeSlot++;
    displacements[bucketIndex] = -(freeSlot + 1);
    used[freeSlot] = 1;
    inputAtSlot[freeSlot] = bucket[0]!;
    inputSlots[bucket[0]!] = freeSlot;
  }

  const slotOffsets = new Uint32Array(count);
  const lengths = new Uint32Array(count);
  for (let slot = 0; slot < count; slot++) {
    const input = inputAtSlot[slot]!;
    slotOffsets[slot] = offsets[input]!;
    lengths[slot] = offsets[input + 1]! - offsets[input]!;
  }
  return { displacements, offsets: slotOffsets, lengths, arena: bytes.slice(), inputSlots };
}

function displacedSlot(hash: number, displacement: number, length: number): number {
  return mix32((hash ^ Math.imul(displacement, 0x9e37_79b9)) >>> 0) % length;
}

function hashBytes(key: Uint8Array, seed: number, multiplier: number, rotate: number): number {
  let hash = seed >>> 0;
  for (const byte of key) {
    hash = Math.imul((hash ^ byte) >>> 0, multiplier) >>> 0;
    if (rotate !== 0) hash = ((hash << rotate) | (hash >>> (32 - rotate))) >>> 0;
  }
  return mix32(hash);
}

function mix32(value: number): number {
  let hash = (value ^ (value >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x7feb_352d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, 0x846c_a68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function flattenKeys(keys: readonly Uint8Array[]): KeyBatch {
  const offsets = new Uint32Array(keys.length + 1);
  let length = 0;
  for (let index = 0; index < keys.length; index++) {
    length += keys[index]!.length;
    if (length > 0xffff_ffff) throw new RangeError("byte arena is too large");
    offsets[index + 1] = length;
  }
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const key of keys) {
    bytes.set(key, cursor);
    cursor += key.length;
  }
  return { bytes, offsets };
}

function validateUniqueBatch(bytes: Uint8Array, offsets: Uint32Array): number {
  const count = validateBatch(bytes, offsets);
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const identity = keyIdentity(bytes.subarray(offsets[index]!, offsets[index + 1]!));
    if (seen.has(identity)) throw new RangeError("MPHF keys must be unique");
    seen.add(identity);
  }
  return count;
}

function validateBatch(bytes: Uint8Array, offsets: Uint32Array): number {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  if (!(offsets instanceof Uint32Array) || offsets.length === 0 || offsets[0] !== 0) {
    throw new RangeError("offsets must start with zero");
  }
  if (offsets.length - 1 > MAX_LENGTH) throw new RangeError("too many MPHF keys");
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index]! < offsets[index - 1]!) throw new RangeError("offsets must be monotone");
  }
  if (offsets[offsets.length - 1] !== bytes.length) {
    throw new RangeError("the final offset must equal bytes.length");
  }
  return offsets.length - 1;
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array)) throw new TypeError("key must be a Uint8Array");
}

function keyIdentity(key: Uint8Array): string {
  let identity = `${key.length}:`;
  for (const byte of key) identity += String.fromCharCode(byte);
  return identity;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
  return value;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}
