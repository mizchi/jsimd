import {
  find as wasmFind,
  find_u64 as wasmFindU64,
  init_controls as wasmInitControls,
  insert_map as wasmInsertMap,
  insert_map_many as wasmInsertMapMany,
  insert_map_many_u64 as wasmInsertMapManyU64,
  insert_map_u64 as wasmInsertMapU64,
  insert_set as wasmInsertSet,
  insert_set_many as wasmInsertSetMany,
  lookup_many as wasmLookupMany,
  map_lookup_many as wasmMapLookupMany,
  map_lookup_many_u64 as wasmMapLookupManyU64,
  memory,
  rehash_map as wasmRehashMap,
  rehash_map_u64 as wasmRehashMapU64,
  rehash_set as wasmRehashSet,
  remove as wasmRemove,
  remove_u64 as wasmRemoveU64,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const MIN_CAPACITY = 16;
const MAX_CAPACITY = 0x1000_0000;
const allocator = new LinearMemoryAllocator(memory);

interface SetStorage {
  readonly controls: Allocation;
  readonly keys: Allocation;
  readonly capacity: number;
}

interface MapStorage extends SetStorage {
  readonly values: Allocation;
}

interface MapU64Storage {
  readonly controls: Allocation;
  readonly keys: Allocation;
  readonly values: Allocation;
  readonly capacity: number;
}

/** A mutable Wasm-resident flat hash set for unsigned 32-bit keys. */
export class FlatHashSetU32 {
  #storage: SetStorage;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#storage = allocateSetStorage(normalizeCapacity(initialCapacity));
  }

  static from(values: Iterable<number>): FlatHashSetU32 {
    const set = new FlatHashSetU32();
    try {
      for (const value of values) set.insert(value);
      return set;
    } catch (error) {
      set.dispose();
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

  has(key: number): boolean {
    this.#assertAlive();
    const normalized = validateUint32(key, "key");
    return wasmFind(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      normalized,
    ) >= 0;
  }

  insert(key: number): this {
    this.#assertAlive();
    const normalized = validateUint32(key, "key");
    this.#ensureCapacity(this.#size + 1);
    this.#size += wasmInsertSet(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      normalized,
    );
    return this;
  }

  insertMany(keys: Uint32Array): this {
    this.#assertAlive();
    assertUint32Array(keys, "keys");
    if (keys.length === 0) return this;
    this.#ensureCapacity(this.#size + keys.length);
    const scratch = allocator.allocate(keys.byteLength);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      this.#size += wasmInsertSetMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.capacity,
        scratch.pointer,
        keys.length,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(keys: Uint32Array, present: Uint8Array): number {
    this.#assertAlive();
    assertUint32Array(keys, "keys");
    if (!(present instanceof Uint8Array) || present.length < keys.length) {
      throw new RangeError("present output must cover every key");
    }
    if (keys.length === 0) return 0;
    const scratch = allocator.allocate(keys.byteLength + keys.length);
    const presentPointer = scratch.pointer + keys.byteLength;
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const found = wasmLookupMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.capacity,
        scratch.pointer,
        keys.length,
        presentPointer,
      );
      present.set(new Uint8Array(memory.buffer, presentPointer, keys.length), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  delete(key: number): boolean {
    this.#assertAlive();
    const normalized = validateUint32(key, "key");
    const removed = wasmRemove(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      normalized,
    ) !== 0;
    if (removed) this.#size--;
    return removed;
  }

  clear(): this {
    this.#assertAlive();
    wasmInitControls(this.#storage.controls.pointer, this.#storage.capacity);
    this.#size = 0;
    return this;
  }

  toUint32Array(): Uint32Array {
    this.#assertAlive();
    const output = new Uint32Array(this.#size);
    this.keysInto(output);
    return output;
  }

  keysInto(output: Uint32Array): number {
    this.#assertAlive();
    if (!(output instanceof Uint32Array)) throw new TypeError("output must be a Uint32Array");
    if (output.length < this.#size) throw new RangeError("output is too small for set keys");
    const controls = new Uint8Array(
      memory.buffer,
      this.#storage.controls.pointer,
      this.#storage.capacity,
    );
    const keys = new Uint32Array(
      memory.buffer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
    );
    let written = 0;
    for (let slot = 0; slot < this.#storage.capacity; slot++) {
      if (controls[slot]! < 128) output[written++] = keys[slot]!;
    }
    return written;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseSetStorage(this.#storage);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #ensureCapacity(requiredSize: number): void {
    const capacity = requiredCapacity(requiredSize, this.#storage.capacity);
    if (capacity === this.#storage.capacity) return;
    const next = allocateSetStorage(capacity);
    wasmRehashSet(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      next.controls.pointer,
      next.keys.pointer,
      next.capacity,
    );
    releaseSetStorage(this.#storage);
    this.#storage = next;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FlatHashSetU32 has been disposed");
  }
}

/** A mutable Wasm-resident flat hash map from unsigned 32-bit keys to unsigned 32-bit values. */
export class FlatHashMapU32U32 {
  #storage: MapStorage;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#storage = allocateMapStorage(normalizeCapacity(initialCapacity));
  }

  static from(entries: Iterable<readonly [number, number]>): FlatHashMapU32U32 {
    const map = new FlatHashMapU32U32();
    try {
      for (const [key, value] of entries) map.set(key, value);
      return map;
    } catch (error) {
      map.dispose();
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

  has(key: number): boolean {
    return this.#findSlot(key) >= 0;
  }

  get(key: number): number | undefined {
    const slot = this.#findSlot(key);
    if (slot < 0) return undefined;
    return new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    )[slot]!;
  }

  set(key: number, value: number): this {
    this.#assertAlive();
    const normalizedKey = validateUint32(key, "key");
    const normalizedValue = validateUint32(value, "value");
    this.#ensureCapacity(this.#size + 1);
    this.#size += wasmInsertMap(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.values.pointer,
      this.#storage.capacity,
      normalizedKey,
      normalizedValue,
    );
    return this;
  }

  insertMany(keys: Uint32Array, values: Uint32Array): this {
    this.#assertAlive();
    assertUint32Array(keys, "keys");
    assertUint32Array(values, "values");
    if (keys.length !== values.length) {
      throw new RangeError("keys and values must have equal length");
    }
    if (keys.length === 0) return this;
    this.#ensureCapacity(this.#size + keys.length);
    const scratch = allocator.allocate(keys.byteLength + values.byteLength);
    const valuesPointer = scratch.pointer + keys.byteLength;
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      new Uint32Array(memory.buffer, valuesPointer, values.length).set(values);
      this.#size += wasmInsertMapMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        valuesPointer,
        keys.length,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(keys: Uint32Array, values: Uint32Array, present: Uint8Array): number {
    this.#assertAlive();
    assertUint32Array(keys, "keys");
    if (!(values instanceof Uint32Array) || values.length < keys.length) {
      throw new RangeError("values output must cover every key");
    }
    if (!(present instanceof Uint8Array) || present.length < keys.length) {
      throw new RangeError("present output must cover every key");
    }
    if (keys.length === 0) return 0;
    const valuesOffset = keys.byteLength;
    const presentOffset = valuesOffset + keys.byteLength;
    const scratch = allocator.allocate(presentOffset + keys.length);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const found = wasmMapLookupMany(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        keys.length,
        scratch.pointer + valuesOffset,
        scratch.pointer + presentOffset,
      );
      values.set(new Uint32Array(memory.buffer, scratch.pointer + valuesOffset, keys.length), 0);
      present.set(new Uint8Array(memory.buffer, scratch.pointer + presentOffset, keys.length), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  delete(key: number): boolean {
    this.#assertAlive();
    const normalized = validateUint32(key, "key");
    const removed = wasmRemove(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      normalized,
    ) !== 0;
    if (removed) this.#size--;
    return removed;
  }

  clear(): this {
    this.#assertAlive();
    wasmInitControls(this.#storage.controls.pointer, this.#storage.capacity);
    this.#size = 0;
    return this;
  }

  entriesInto(keysOutput: Uint32Array, valuesOutput: Uint32Array): number {
    this.#assertAlive();
    if (!(keysOutput instanceof Uint32Array)) {
      throw new TypeError("keysOutput must be a Uint32Array");
    }
    if (!(valuesOutput instanceof Uint32Array)) {
      throw new TypeError("valuesOutput must be a Uint32Array");
    }
    if (keysOutput.length < this.#size || valuesOutput.length < this.#size) {
      throw new RangeError("entry outputs must cover every map entry");
    }
    const controls = new Uint8Array(
      memory.buffer,
      this.#storage.controls.pointer,
      this.#storage.capacity,
    );
    const keys = new Uint32Array(memory.buffer, this.#storage.keys.pointer, this.#storage.capacity);
    const values = new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    );
    let written = 0;
    for (let slot = 0; slot < this.#storage.capacity; slot++) {
      if (controls[slot]! >= 128) continue;
      keysOutput[written] = keys[slot]!;
      valuesOutput[written] = values[slot]!;
      written++;
    }
    return written;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseMapStorage(this.#storage);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #findSlot(key: number): number {
    this.#assertAlive();
    const normalized = validateUint32(key, "key");
    return wasmFind(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      normalized,
    );
  }

  #ensureCapacity(requiredSize: number): void {
    const capacity = requiredCapacity(requiredSize, this.#storage.capacity);
    if (capacity === this.#storage.capacity) return;
    const next = allocateMapStorage(capacity);
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
    releaseMapStorage(this.#storage);
    this.#storage = next;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FlatHashMapU32U32 has been disposed");
  }
}

/** A mutable Wasm-resident flat hash map from unsigned 64-bit keys to u32 values. */
export class FlatHashMapU64U32 {
  #storage: MapU64Storage;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#storage = allocateMapU64Storage(normalizeCapacity(initialCapacity));
  }

  static from(entries: Iterable<readonly [bigint, number]>): FlatHashMapU64U32 {
    const map = new FlatHashMapU64U32();
    try {
      for (const [key, value] of entries) map.set(key, value);
      return map;
    } catch (error) {
      map.dispose();
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

  has(key: bigint): boolean {
    return this.#findSlot(key) >= 0;
  }

  get(key: bigint): number | undefined {
    const slot = this.#findSlot(key);
    if (slot < 0) return undefined;
    return new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    )[slot]!;
  }

  set(key: bigint, value: number): this {
    this.#assertAlive();
    const normalizedKey = validateUint64(key, "key");
    const normalizedValue = validateUint32(value, "value");
    this.#ensureCapacity(this.#size + 1);
    this.#size += wasmInsertMapU64(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.values.pointer,
      this.#storage.capacity,
      normalizedKey,
      normalizedValue,
    );
    return this;
  }

  insertMany(keys: BigUint64Array, values: Uint32Array): this {
    this.#assertAlive();
    if (!(keys instanceof BigUint64Array)) throw new TypeError("keys must be a BigUint64Array");
    assertUint32Array(values, "values");
    if (keys.length !== values.length) {
      throw new RangeError("keys and values must have equal length");
    }
    if (keys.length === 0) return this;
    this.#ensureCapacity(this.#size + keys.length);
    const scratch = allocator.allocate(keys.byteLength + values.byteLength);
    const valuesPointer = scratch.pointer + keys.byteLength;
    try {
      new BigUint64Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      new Uint32Array(memory.buffer, valuesPointer, values.length).set(values);
      this.#size += wasmInsertMapManyU64(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        valuesPointer,
        keys.length,
      );
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(keys: BigUint64Array, values: Uint32Array, present: Uint8Array): number {
    this.#assertAlive();
    if (!(keys instanceof BigUint64Array)) throw new TypeError("keys must be a BigUint64Array");
    if (!(values instanceof Uint32Array) || values.length < keys.length) {
      throw new RangeError("values output must cover every key");
    }
    if (!(present instanceof Uint8Array) || present.length < keys.length) {
      throw new RangeError("present output must cover every key");
    }
    if (keys.length === 0) return 0;
    const valuesOffset = keys.byteLength;
    const presentOffset = valuesOffset + keys.length * 4;
    const scratch = allocator.allocate(presentOffset + keys.length);
    try {
      new BigUint64Array(memory.buffer, scratch.pointer, keys.length).set(keys);
      const found = wasmMapLookupManyU64(
        this.#storage.controls.pointer,
        this.#storage.keys.pointer,
        this.#storage.values.pointer,
        this.#storage.capacity,
        scratch.pointer,
        keys.length,
        scratch.pointer + valuesOffset,
        scratch.pointer + presentOffset,
      );
      values.set(new Uint32Array(memory.buffer, scratch.pointer + valuesOffset, keys.length), 0);
      present.set(new Uint8Array(memory.buffer, scratch.pointer + presentOffset, keys.length), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  delete(key: bigint): boolean {
    this.#assertAlive();
    const removed = wasmRemoveU64(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      validateUint64(key, "key"),
    ) !== 0;
    if (removed) this.#size--;
    return removed;
  }

  clear(): this {
    this.#assertAlive();
    wasmInitControls(this.#storage.controls.pointer, this.#storage.capacity);
    this.#size = 0;
    return this;
  }

  entriesInto(keysOutput: BigUint64Array, valuesOutput: Uint32Array): number {
    this.#assertAlive();
    if (!(keysOutput instanceof BigUint64Array)) {
      throw new TypeError("keysOutput must be a BigUint64Array");
    }
    if (!(valuesOutput instanceof Uint32Array)) {
      throw new TypeError("valuesOutput must be a Uint32Array");
    }
    if (keysOutput.length < this.#size || valuesOutput.length < this.#size) {
      throw new RangeError("entry outputs must cover every map entry");
    }
    const controls = new Uint8Array(
      memory.buffer,
      this.#storage.controls.pointer,
      this.#storage.capacity,
    );
    const keys = new BigUint64Array(
      memory.buffer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
    );
    const values = new Uint32Array(
      memory.buffer,
      this.#storage.values.pointer,
      this.#storage.capacity,
    );
    let written = 0;
    for (let slot = 0; slot < this.#storage.capacity; slot++) {
      if (controls[slot]! >= 128) continue;
      keysOutput[written] = keys[slot]!;
      valuesOutput[written] = values[slot]!;
      written++;
    }
    return written;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseMapU64Storage(this.#storage);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #findSlot(key: bigint): number {
    this.#assertAlive();
    return wasmFindU64(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.capacity,
      validateUint64(key, "key"),
    );
  }

  #ensureCapacity(requiredSize: number): void {
    const capacity = requiredCapacity(requiredSize, this.#storage.capacity);
    if (capacity === this.#storage.capacity) return;
    const next = allocateMapU64Storage(capacity);
    wasmRehashMapU64(
      this.#storage.controls.pointer,
      this.#storage.keys.pointer,
      this.#storage.values.pointer,
      this.#storage.capacity,
      next.controls.pointer,
      next.keys.pointer,
      next.values.pointer,
      next.capacity,
    );
    releaseMapU64Storage(this.#storage);
    this.#storage = next;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FlatHashMapU64U32 has been disposed");
  }
}

function allocateSetStorage(capacity: number): SetStorage {
  let controls: Allocation | undefined;
  let keys: Allocation | undefined;
  try {
    controls = allocator.allocate(capacity);
    keys = allocator.allocate(capacity * 4);
    wasmInitControls(controls.pointer, capacity);
    return { controls, keys, capacity };
  } catch (error) {
    if (keys !== undefined) allocator.release(keys);
    if (controls !== undefined) allocator.release(controls);
    throw error;
  }
}

function allocateMapStorage(capacity: number): MapStorage {
  const setStorage = allocateSetStorage(capacity);
  try {
    const values = allocator.allocate(capacity * 4);
    return { ...setStorage, values };
  } catch (error) {
    releaseSetStorage(setStorage);
    throw error;
  }
}

function allocateMapU64Storage(capacity: number): MapU64Storage {
  let controls: Allocation | undefined;
  let keys: Allocation | undefined;
  let values: Allocation | undefined;
  try {
    controls = allocator.allocate(capacity);
    keys = allocator.allocate(capacity * 8);
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

function releaseSetStorage(storage: SetStorage): void {
  allocator.release(storage.keys);
  allocator.release(storage.controls);
}

function releaseMapStorage(storage: MapStorage): void {
  allocator.release(storage.values);
  releaseSetStorage(storage);
}

function releaseMapU64Storage(storage: MapU64Storage): void {
  allocator.release(storage.values);
  allocator.release(storage.keys);
  allocator.release(storage.controls);
}

function requiredCapacity(requiredSize: number, currentCapacity: number): number {
  let capacity = currentCapacity;
  while (requiredSize * 8 > capacity * 7) {
    if (capacity >= MAX_CAPACITY) throw new RangeError("flat hash table capacity exceeded");
    capacity *= 2;
  }
  return capacity;
}

function normalizeCapacity(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > MAX_CAPACITY) {
    throw new RangeError("invalid flat hash capacity");
  }
  let capacity = MIN_CAPACITY;
  while (capacity < requested) capacity *= 2;
  return capacity;
}

function validateUint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
  return value;
}

function validateUint64(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must be an unsigned 64-bit bigint`);
  }
  return value;
}

function assertUint32Array(value: unknown, label: string): asserts value is Uint32Array {
  if (!(value instanceof Uint32Array)) throw new TypeError(`${label} must be a Uint32Array`);
}
