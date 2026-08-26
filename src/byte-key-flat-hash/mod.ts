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

const MIN_CAPACITY = 16;
const MIN_ARENA_BYTES = 256;
const MAX_CAPACITY = 0x0400_0000;
const MAX_BYTE_LENGTH = 0xffff_fff0;
const allocator = new LinearMemoryAllocator(memory);

interface TableStorage {
  readonly controls: Allocation;
  readonly offsets: Allocation;
  readonly lengths: Allocation;
  readonly values: Allocation;
  readonly capacity: number;
}

/** Mutable Wasm-resident flat hash map from arbitrary byte keys to Uint32 values. */
export class ByteKeyFlatHashMapU32 {
  #table: TableStorage;
  #arena: Allocation;
  #arenaLength = 0;
  #size = 0;
  #disposed = false;

  constructor(initialCapacity = MIN_CAPACITY) {
    this.#table = allocateTable(normalizeCapacity(initialCapacity));
    try {
      this.#arena = allocator.allocate(MIN_ARENA_BYTES);
    } catch (error) {
      releaseTable(this.#table);
      throw error;
    }
  }

  static from(
    entries: Iterable<readonly [Uint8Array, number]>,
  ): ByteKeyFlatHashMapU32 {
    const map = new ByteKeyFlatHashMapU32();
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
    return this.#table.capacity;
  }

  /** Bytes appended to the arena, including dead bytes left by bulk duplicates/deletions. */
  get arenaBytes(): number {
    this.#assertAlive();
    return this.#arenaLength;
  }

  has(key: Uint8Array): boolean {
    return this.#findSlot(key) >= 0;
  }

  get(key: Uint8Array): number | undefined {
    const slot = this.#findSlot(key);
    if (slot < 0) return undefined;
    return new Uint32Array(memory.buffer, this.#table.values.pointer, this.#table.capacity)[slot]!;
  }

  set(key: Uint8Array, value: number): this {
    this.#assertAlive();
    validateKey(key);
    const normalizedValue = validateUint32(value);
    const existing = this.#findSlot(key);
    if (existing >= 0) {
      new Uint32Array(memory.buffer, this.#table.values.pointer, this.#table.capacity)[existing] =
        normalizedValue;
      return this;
    }
    this.#ensureTableCapacity(this.#size + 1);
    this.#ensureArenaCapacity(this.#arenaLength + key.length);
    const keyOffset = this.#arenaLength;
    if (key.length !== 0) {
      new Uint8Array(memory.buffer, this.#arena.pointer + keyOffset, key.length).set(key);
    }
    this.#size += wasmInsertMap(
      this.#table.controls.pointer,
      this.#table.offsets.pointer,
      this.#table.lengths.pointer,
      this.#table.values.pointer,
      this.#table.capacity,
      this.#arena.pointer,
      this.#arena.pointer + keyOffset,
      key.length,
      keyOffset,
      normalizedValue,
    );
    this.#arenaLength += key.length;
    return this;
  }

  /**
   * Inserts keys encoded as `bytes[offsets[i]..offsets[i + 1]]` in one Wasm call.
   * Duplicate payload bytes may remain in the append-only arena.
   */
  insertMany(bytes: Uint8Array, offsets: Uint32Array, values: Uint32Array): this {
    this.#assertAlive();
    const count = validateBatch(bytes, offsets);
    if (!(values instanceof Uint32Array) || values.length !== count) {
      throw new RangeError("values must contain one Uint32 for every key");
    }
    if (count === 0) return this;
    this.#ensureTableCapacity(this.#size + count);
    const baseOffset = this.#arenaLength;
    this.#ensureArenaCapacity(baseOffset + bytes.length);
    if (bytes.length !== 0) {
      new Uint8Array(memory.buffer, this.#arena.pointer + baseOffset, bytes.length).set(bytes);
    }
    const valuesOffset = offsets.byteLength;
    const scratch = allocator.allocate(valuesOffset + values.byteLength);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, offsets.length).set(offsets);
      new Uint32Array(memory.buffer, scratch.pointer + valuesOffset, values.length).set(values);
      this.#size += wasmInsertMapMany(
        this.#table.controls.pointer,
        this.#table.offsets.pointer,
        this.#table.lengths.pointer,
        this.#table.values.pointer,
        this.#table.capacity,
        this.#arena.pointer,
        baseOffset,
        scratch.pointer,
        scratch.pointer + valuesOffset,
        count,
      );
      this.#arenaLength += bytes.length;
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  lookupMany(
    bytes: Uint8Array,
    offsets: Uint32Array,
    values: Uint32Array,
    present: Uint8Array,
  ): number {
    this.#assertAlive();
    const count = validateBatch(bytes, offsets);
    if (!(values instanceof Uint32Array) || values.length < count) {
      throw new RangeError("values output must cover every key");
    }
    if (!(present instanceof Uint8Array) || present.length < count) {
      throw new RangeError("present output must cover every key");
    }
    if (count === 0) return 0;
    const offsetsOffset = align4(bytes.byteLength);
    const valuesOffset = offsetsOffset + offsets.byteLength;
    const presentOffset = valuesOffset + count * 4;
    const scratch = allocator.allocate(presentOffset + count);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, bytes.length).set(bytes);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, offsets.length).set(offsets);
      const found = wasmLookupMany(
        this.#table.controls.pointer,
        this.#table.offsets.pointer,
        this.#table.lengths.pointer,
        this.#table.values.pointer,
        this.#table.capacity,
        this.#arena.pointer,
        scratch.pointer,
        scratch.pointer + offsetsOffset,
        count,
        scratch.pointer + valuesOffset,
        scratch.pointer + presentOffset,
      );
      values.set(new Uint32Array(memory.buffer, scratch.pointer + valuesOffset, count), 0);
      present.set(new Uint8Array(memory.buffer, scratch.pointer + presentOffset, count), 0);
      return found;
    } finally {
      allocator.release(scratch);
    }
  }

  delete(key: Uint8Array): boolean {
    this.#assertAlive();
    validateKey(key);
    const scratch = allocator.allocate(key.length);
    try {
      if (key.length !== 0) {
        new Uint8Array(memory.buffer, scratch.pointer, key.length).set(key);
      }
      const removed = wasmRemove(
        this.#table.controls.pointer,
        this.#table.offsets.pointer,
        this.#table.lengths.pointer,
        this.#table.capacity,
        this.#arena.pointer,
        scratch.pointer,
        key.length,
      ) !== 0;
      if (removed) this.#size--;
      return removed;
    } finally {
      allocator.release(scratch);
    }
  }

  clear(): this {
    this.#assertAlive();
    wasmInitControls(this.#table.controls.pointer, this.#table.capacity);
    this.#size = 0;
    this.#arenaLength = 0;
    return this;
  }

  entriesInto(
    bytesOutput: Uint8Array,
    offsetsOutput: Uint32Array,
    valuesOutput: Uint32Array,
  ): number {
    this.#assertAlive();
    if (!(bytesOutput instanceof Uint8Array)) {
      throw new TypeError("bytesOutput must be a Uint8Array");
    }
    if (!(offsetsOutput instanceof Uint32Array)) {
      throw new TypeError("offsetsOutput must be a Uint32Array");
    }
    if (!(valuesOutput instanceof Uint32Array)) {
      throw new TypeError("valuesOutput must be a Uint32Array");
    }
    if (offsetsOutput.length < this.#size + 1 || valuesOutput.length < this.#size) {
      throw new RangeError("entry outputs must cover every map entry");
    }
    const controls = new Uint8Array(
      memory.buffer,
      this.#table.controls.pointer,
      this.#table.capacity,
    );
    const keyOffsets = new Uint32Array(
      memory.buffer,
      this.#table.offsets.pointer,
      this.#table.capacity,
    );
    const keyLengths = new Uint32Array(
      memory.buffer,
      this.#table.lengths.pointer,
      this.#table.capacity,
    );
    let requiredBytes = 0;
    for (let slot = 0; slot < this.#table.capacity; slot++) {
      if (controls[slot]! < 128) requiredBytes += keyLengths[slot]!;
    }
    if (bytesOutput.length < requiredBytes) {
      throw new RangeError("bytesOutput is too small for live key bytes");
    }
    const arena = new Uint8Array(memory.buffer, this.#arena.pointer, this.#arenaLength);
    const values = new Uint32Array(
      memory.buffer,
      this.#table.values.pointer,
      this.#table.capacity,
    );
    let written = 0;
    let byteOffset = 0;
    offsetsOutput[0] = 0;
    for (let slot = 0; slot < this.#table.capacity; slot++) {
      if (controls[slot]! >= 128) continue;
      const keyOffset = keyOffsets[slot]!;
      const keyLength = keyLengths[slot]!;
      bytesOutput.set(arena.subarray(keyOffset, keyOffset + keyLength), byteOffset);
      byteOffset += keyLength;
      valuesOutput[written] = values[slot]!;
      offsetsOutput[++written] = byteOffset;
    }
    return written;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#arena);
    releaseTable(this.#table);
  }

  #findSlot(key: Uint8Array): number {
    this.#assertAlive();
    validateKey(key);
    const scratch = allocator.allocate(key.length);
    try {
      if (key.length !== 0) {
        new Uint8Array(memory.buffer, scratch.pointer, key.length).set(key);
      }
      return wasmFind(
        this.#table.controls.pointer,
        this.#table.offsets.pointer,
        this.#table.lengths.pointer,
        this.#table.capacity,
        this.#arena.pointer,
        scratch.pointer,
        key.length,
      );
    } finally {
      allocator.release(scratch);
    }
  }

  #ensureTableCapacity(requiredSize: number): void {
    const nextCapacity = requiredCapacity(requiredSize, this.#table.capacity);
    if (nextCapacity === this.#table.capacity) return;
    const next = allocateTable(nextCapacity);
    try {
      wasmRehashMap(
        this.#table.controls.pointer,
        this.#table.offsets.pointer,
        this.#table.lengths.pointer,
        this.#table.values.pointer,
        this.#table.capacity,
        this.#arena.pointer,
        next.controls.pointer,
        next.offsets.pointer,
        next.lengths.pointer,
        next.values.pointer,
        next.capacity,
      );
    } catch (error) {
      releaseTable(next);
      throw error;
    }
    releaseTable(this.#table);
    this.#table = next;
  }

  #ensureArenaCapacity(requiredBytes: number): void {
    if (
      !Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > MAX_BYTE_LENGTH
    ) {
      throw new RangeError("byte-key arena is too large");
    }
    if (requiredBytes <= this.#arena.byteLength) return;
    const next = allocator.allocate(requiredBytes);
    new Uint8Array(memory.buffer, next.pointer, this.#arenaLength).set(
      new Uint8Array(memory.buffer, this.#arena.pointer, this.#arenaLength),
    );
    allocator.release(this.#arena);
    this.#arena = next;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("ByteKeyFlatHashMapU32 has been disposed");
  }
}

function allocateTable(capacity: number): TableStorage {
  let controls: Allocation | undefined;
  let offsets: Allocation | undefined;
  let lengths: Allocation | undefined;
  let values: Allocation | undefined;
  try {
    controls = allocator.allocate(capacity);
    offsets = allocator.allocate(capacity * 4);
    lengths = allocator.allocate(capacity * 4);
    values = allocator.allocate(capacity * 4);
    wasmInitControls(controls.pointer, capacity);
    return { controls, offsets, lengths, values, capacity };
  } catch (error) {
    if (values !== undefined) allocator.release(values);
    if (lengths !== undefined) allocator.release(lengths);
    if (offsets !== undefined) allocator.release(offsets);
    if (controls !== undefined) allocator.release(controls);
    throw error;
  }
}

function releaseTable(storage: TableStorage): void {
  allocator.release(storage.values);
  allocator.release(storage.lengths);
  allocator.release(storage.offsets);
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
  if (!(key instanceof Uint8Array) || key.length > MAX_BYTE_LENGTH) {
    throw new RangeError("key must be a Uint8Array with a supported length");
  }
}

function validateBatch(bytes: Uint8Array, offsets: Uint32Array): number {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  if (!(offsets instanceof Uint32Array) || offsets.length === 0 || offsets[0] !== 0) {
    throw new RangeError("offsets must start with zero");
  }
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index]! < offsets[index - 1]!) {
      throw new RangeError("offsets must be monotone");
    }
  }
  if (offsets[offsets.length - 1] !== bytes.length) {
    throw new RangeError("the final offset must equal bytes.length");
  }
  return offsets.length - 1;
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
