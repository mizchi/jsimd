import {
  find as wasmFind,
  init_controls as wasmInitControls,
  insert_map as wasmInsertMap,
  insert_map_many as wasmInsertMapMany,
  lookup_many as wasmLookupMany,
  memory,
  rehash_map as wasmRehashMap,
  remove as wasmRemove,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const KEY_BYTES = 16;
const MIN_CAPACITY = 16;
const MAX_CAPACITY = 0x0400_0000;
const allocator = new LinearMemoryAllocator(memory);

interface Storage {
  readonly controls: Allocation;
  readonly keys: Allocation;
  readonly values: Allocation;
  readonly capacity: number;
}

/** Mutable Wasm-resident flat hash map from fixed 16-byte keys to Uint32 values. */
export class FlatHashMapFixed16U32 {
  #storage: Storage;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#storage = allocateStorage(normalizeCapacity(initialCapacity));
  }

  static from(entries: Iterable<readonly [Uint8Array, number]>): FlatHashMapFixed16U32 {
    const map = new FlatHashMapFixed16U32();
    try {
      for (const [key, value] of entries) map.set(key, value);
      return map;
    } catch (error) {
      map[Symbol.dispose]();
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

  get capacity(): number {
    this.#assertAlive();
    return this.#storage.capacity;
  }

  has(key: Uint8Array): boolean {
    return this.#findSlot(key) >= 0;
  }

  get(key: Uint8Array): number | undefined {
    const slot = this.#findSlot(key);
    if (slot < 0) return undefined;
    return new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    )[slot]!;
  }

  set(key: Uint8Array, value: number): this {
    this.#assertAlive();
    validateKey(key);
    const normalizedValue = validateUint32(value);
    this.#ensureCapacity(this.#size + 1);
    const scratch = allocator.allocate(KEY_BYTES);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, KEY_BYTES).set(key);
      this.#size += wasmInsertMap(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        normalizedValue,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  insertMany(keys: Uint8Array, values: Uint32Array): this {
    this.#assertAlive();
    const length = validateKeyBatch(keys);
    if (!(values instanceof Uint32Array) || values.length !== length) {
      throw new RangeError("values must contain one Uint32 for every key");
    }
    if (length === 0) return this;
    this.#ensureCapacity(this.#size + length);
    const scratch = allocator.allocate(keys.byteLength + values.byteLength);
    const valuesPointer = scratch.pointer + keys.byteLength;
    try {
      new Uint8Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      new Uint32Array(memory.buffer, valuesPointer, values.length).set(values);
      this.#size += wasmInsertMapMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        valuesPointer,
        length,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(keys: Uint8Array, values: Uint32Array, present: Uint8Array): number {
    this.#assertAlive();
    const length = validateKeyBatch(keys);
    if (!(values instanceof Uint32Array) || values.length < length) {
      throw new RangeError("values output must cover every key");
    }
    if (!(present instanceof Uint8Array) || present.length < length) {
      throw new RangeError("present output must cover every key");
    }
    if (length === 0) return 0;
    const valuesOffset = keys.byteLength;
    const presentOffset = valuesOffset + length * 4;
    const scratch = allocator.allocate(presentOffset + length);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const found = wasmLookupMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        length,
        scratch.pointer + valuesOffset,
        scratch.pointer + presentOffset,
      );
      values.set(new Uint32Array(memory.buffer, scratch.pointer + valuesOffset, length), 0);
      present.set(new Uint8Array(memory.buffer, scratch.pointer + presentOffset, length), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  delete(key: Uint8Array): boolean {
    this.#assertAlive();
    validateKey(key);
    const scratch = allocator.allocate(KEY_BYTES);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, KEY_BYTES).set(key);
      const removed = wasmRemove(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.capacity,
        scratch.pointer,
      ) !== 0;
      if (removed) this.#size--;
      return removed;
    } finally {
      allocator.release(scratch);
    }
  }

  clear(): this {
    this.#assertAlive();
    wasmInitControls(this.#storage.controls.pointer, this.#storage.capacity);
    this.#size = 0;
    return this;
  }

  keysInto(output: Uint8Array): number {
    this.#assertAlive();
    if (!(output instanceof Uint8Array)) throw new TypeError("output must be a Uint8Array");
    if (output.length < this.#size * KEY_BYTES) {
      throw new RangeError("output is too small for fixed-width keys");
    }
    const controls = new Uint8Array(
      memory.buffer,
      this.#storage.controls.pointer,
      this.#storage.capacity,
    );
    const keys = new Uint8Array(
      memory.buffer,
      this.#storage.keys.pointer,
      this.#storage.capacity * KEY_BYTES,
    );
    let written = 0;
    for (let slot = 0; slot < this.#storage.capacity; slot++) {
      if (controls[slot]! >= 128) continue;
      output.set(keys.subarray(slot * KEY_BYTES, (slot + 1) * KEY_BYTES), written * KEY_BYTES);
      written++;
    }
    return written;
  }

  entriesInto(keysOutput: Uint8Array, valuesOutput: Uint32Array): number {
    this.#assertAlive();
    if (!(valuesOutput instanceof Uint32Array)) {
      throw new TypeError("valuesOutput must be a Uint32Array");
    }
    if (valuesOutput.length < this.#size) {
      throw new RangeError("valuesOutput must cover every map entry");
    }
    if (!(keysOutput instanceof Uint8Array)) {
      throw new TypeError("keysOutput must be a Uint8Array");
    }
    if (keysOutput.length < this.#size * KEY_BYTES) {
      throw new RangeError("keysOutput is too small for fixed-width keys");
    }
    const controls = new Uint8Array(
      memory.buffer,
      this.#storage.controls.pointer,
      this.#storage.capacity,
    );
    const keys = new Uint8Array(
      memory.buffer,
      this.#storage.keys.pointer,
      this.#storage.capacity * KEY_BYTES,
    );
    const values = new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    );
    let written = 0;
    for (let slot = 0; slot < this.#storage.capacity; slot++) {
      if (controls[slot]! >= 128) continue;
      keysOutput.set(
        keys.subarray(slot * KEY_BYTES, (slot + 1) * KEY_BYTES),
        written * KEY_BYTES,
      );
      valuesOutput[written] = values[slot]!;
      written++;
    }
    return written;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseStorage(this.#storage);
  }

  #findSlot(key: Uint8Array): number {
    this.#assertAlive();
    validateKey(key);
    const scratch = allocator.allocate(KEY_BYTES);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, KEY_BYTES).set(key);
      return wasmFind(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.capacity,
        scratch.pointer,
      );
    } finally {
      allocator.release(scratch);
    }
  }

  #ensureCapacity(requiredSize: number): void {
    const nextCapacity = requiredCapacity(requiredSize, this.#storage.capacity);
    if (nextCapacity === this.#storage.capacity) return;
    const next = allocateStorage(nextCapacity);
    try {
      wasmRehashMap(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        next.controls.pointer,
        next.keys.pointer,
        next.values.pointer,
        next.capacity,
      );
    } catch (error) {
      releaseStorage(next);
      throw error;
    }
    releaseStorage(this.#storage);
    this.#storage = next;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FlatHashMapFixed16U32 has been disposed");
  }
}

/** Fixed-16-byte-key set derived from the same resident map kernel. */
export class FlatHashSetFixed16 {
  readonly #map: FlatHashMapFixed16U32;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#map = new FlatHashMapFixed16U32(initialCapacity);
  }

  static from(keys: Iterable<Uint8Array>): FlatHashSetFixed16 {
    const set = new FlatHashSetFixed16();
    try {
      for (const key of keys) set.add(key);
      return set;
    } catch (error) {
      set[Symbol.dispose]();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return FlatHashMapFixed16U32.allocatorStats();
  }

  get size(): number {
    return this.#map.size;
  }

  get capacity(): number {
    return this.#map.capacity;
  }

  add(key: Uint8Array): this {
    this.#map.set(key, 1);
    return this;
  }

  addMany(keys: Uint8Array): this {
    this.#map.insertMany(keys, new Uint32Array(validateKeyBatch(keys)).fill(1));
    return this;
  }

  has(key: Uint8Array): boolean {
    return this.#map.has(key);
  }

  delete(key: Uint8Array): boolean {
    return this.#map.delete(key);
  }

  lookupMany(keys: Uint8Array, present: Uint8Array): number {
    return this.#map.lookupMany(keys, new Uint32Array(validateKeyBatch(keys)), present);
  }

  clear(): this {
    this.#map.clear();
    return this;
  }

  keysInto(output: Uint8Array): number {
    return this.#map.keysInto(output);
  }

  [Symbol.dispose](): void {
    this.#map[Symbol.dispose]();
  }
}

function allocateStorage(capacity: number): Storage {
  let controls: Allocation | undefined;
  let keys: Allocation | undefined;
  let values: Allocation | undefined;
  try {
    controls = allocator.allocate(capacity);
    keys = allocator.allocate(capacity * KEY_BYTES);
    values = allocator.allocate(capacity * 4);
    wasmInitControls(controls.pointer, capacity);
    return { controls, keys, values, capacity };
  } catch (error) {
    if (values !== undefined) allocator.release(values);
    if (keys !== undefined) allocator.release(keys);
    if (controls !== undefined) allocator.release(controls);
    throw error;
  }
}

function releaseStorage(storage: Storage): void {
  allocator.release(storage.values);
  allocator.release(storage.keys);
  allocator.release(storage.controls);
}

function normalizeCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CAPACITY) {
    throw new RangeError("invalid capacity");
  }
  let capacity = MIN_CAPACITY;
  while (capacity < value) capacity *= 2;
  return capacity;
}

function requiredCapacity(size: number, current: number): number {
  let capacity = current;
  while (size > capacity - capacity / 8) {
    if (capacity >= MAX_CAPACITY) throw new RangeError("hash table is too large");
    capacity *= 2;
  }
  return capacity;
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new RangeError("key must contain exactly 16 bytes");
  }
}

function validateKeyBatch(keys: Uint8Array): number {
  if (!(keys instanceof Uint8Array) || keys.length % KEY_BYTES !== 0) {
    throw new RangeError("keys must contain contiguous 16-byte keys");
  }
  return keys.length / KEY_BYTES;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
  return value;
}
