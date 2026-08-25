import {
  deleted_mask as wasmDeletedMask,
  empty_mask as wasmEmptyMask,
  match_many as wasmMatchMany,
  match_mask as wasmMatchMask,
  memory,
  table_probe_many as wasmTableProbeMany,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const GROUP_SIZE = 16;
const EMPTY = 0x80;
const DELETED = 0xfe;
const allocator = new LinearMemoryAllocator(memory);

/** One Wasm-resident SwissTable-compatible 16-byte fingerprint control group. */
export class FingerprintGroup16 {
  readonly #allocation: Allocation;
  #disposed = false;

  private constructor(controls: Uint8Array) {
    this.#allocation = allocator.allocate(GROUP_SIZE);
    new Uint8Array(memory.buffer, this.#allocation.pointer, GROUP_SIZE).set(controls);
  }

  static from(controls: Uint8Array): FingerprintGroup16 {
    if (!(controls instanceof Uint8Array) || controls.length !== GROUP_SIZE) {
      throw new RangeError("controls must contain exactly 16 bytes");
    }
    for (const control of controls) validateControl(control);
    return new FingerprintGroup16(controls);
  }

  static empty(): FingerprintGroup16 {
    return new FingerprintGroup16(new Uint8Array(GROUP_SIZE).fill(EMPTY));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  matchMask(fingerprint: number): number {
    this.#assertAlive();
    validateFingerprint(fingerprint);
    return wasmMatchMask(this.#allocation.pointer, fingerprint) & 0xffff;
  }

  emptyMask(): number {
    this.#assertAlive();
    return wasmEmptyMask(this.#allocation.pointer) & 0xffff;
  }

  deletedMask(): number {
    this.#assertAlive();
    return wasmDeletedMask(this.#allocation.pointer) & 0xffff;
  }

  availableMask(): number {
    return this.emptyMask() | this.deletedMask();
  }

  firstMatch(fingerprint: number): number {
    const mask = this.matchMask(fingerprint);
    return mask === 0 ? -1 : 31 - Math.clz32(mask & -mask);
  }

  matchMany(fingerprints: Uint8Array, output: Uint16Array): void {
    this.#assertAlive();
    if (!(fingerprints instanceof Uint8Array)) {
      throw new TypeError("fingerprints must be Uint8Array");
    }
    if (!(output instanceof Uint16Array) || output.length < fingerprints.length) {
      throw new RangeError("output must cover every fingerprint");
    }
    for (const fingerprint of fingerprints) validateFingerprint(fingerprint);
    if (fingerprints.length === 0) return;
    const inputAllocation = allocator.allocate(fingerprints.byteLength);
    const outputAllocation = allocator.allocate(fingerprints.length * 2);
    try {
      new Uint8Array(memory.buffer, inputAllocation.pointer, fingerprints.length).set(fingerprints);
      wasmMatchMany(
        this.#allocation.pointer,
        inputAllocation.pointer,
        outputAllocation.pointer,
        fingerprints.length,
      );
      output.set(new Uint16Array(memory.buffer, outputAllocation.pointer, fingerprints.length), 0);
    } finally {
      allocator.release(outputAllocation);
      allocator.release(inputAllocation);
    }
  }

  toUint8Array(): Uint8Array {
    this.#assertAlive();
    return new Uint8Array(
      new Uint8Array(memory.buffer, this.#allocation.pointer, GROUP_SIZE),
    );
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FingerprintGroup16 has been disposed");
  }
}

/** A power-of-two table of contiguous 16-byte fingerprint groups. */
export class FingerprintTable16 {
  readonly capacity: number;
  readonly groupCount: number;
  readonly #allocation: Allocation;
  #disposed = false;

  constructor(capacity: number) {
    if (
      !Number.isSafeInteger(capacity) || capacity < GROUP_SIZE || (capacity & (capacity - 1)) !== 0
    ) {
      throw new RangeError("capacity must be a power of two and at least 16");
    }
    this.capacity = capacity;
    this.groupCount = capacity / GROUP_SIZE;
    this.#allocation = allocator.allocate(capacity);
    new Uint8Array(memory.buffer, this.#allocation.pointer, capacity).fill(EMPTY);
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  setControl(slot: number, control: number): this {
    this.#checkSlot(slot);
    validateControl(control);
    this.#controls()[slot] = control;
    return this;
  }

  delete(slot: number): this {
    return this.setControl(slot, DELETED);
  }

  matchMask(group: number, fingerprint: number): number {
    validateFingerprint(fingerprint);
    return wasmMatchMask(this.#groupPointer(group), fingerprint) & 0xffff;
  }

  emptyMask(group: number): number {
    return wasmEmptyMask(this.#groupPointer(group)) & 0xffff;
  }

  deletedMask(group: number): number {
    return wasmDeletedMask(this.#groupPointer(group)) & 0xffff;
  }

  probeMany(
    hashes: Uint32Array,
    groupOffsets: Uint32Array,
    matches: Uint16Array,
    empty: Uint16Array,
    deleted: Uint16Array,
  ): void {
    this.#assertAlive();
    const length = hashes.length;
    if (
      groupOffsets.length < length || matches.length < length || empty.length < length ||
      deleted.length < length
    ) throw new RangeError("every output must cover all hashes");
    if (length === 0) return;
    const hashesBytes = length * 4;
    const groupsBytes = length * 4;
    const masksBytes = length * 2;
    const scratch = allocator.allocate(hashesBytes + groupsBytes + masksBytes * 3);
    const groupsPointer = scratch.pointer + hashesBytes;
    const matchesPointer = groupsPointer + groupsBytes;
    const emptyPointer = matchesPointer + masksBytes;
    const deletedPointer = emptyPointer + masksBytes;
    try {
      new Uint32Array(memory.buffer, scratch.pointer, length).set(hashes);
      wasmTableProbeMany(
        this.#allocation.pointer,
        this.capacity,
        scratch.pointer,
        groupsPointer,
        matchesPointer,
        emptyPointer,
        deletedPointer,
        length,
      );
      groupOffsets.set(new Uint32Array(memory.buffer, groupsPointer, length), 0);
      matches.set(new Uint16Array(memory.buffer, matchesPointer, length), 0);
      empty.set(new Uint16Array(memory.buffer, emptyPointer, length), 0);
      deleted.set(new Uint16Array(memory.buffer, deletedPointer, length), 0);
    } finally {
      allocator.release(scratch);
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #controls(): Uint8Array {
    this.#assertAlive();
    return new Uint8Array(memory.buffer, this.#allocation.pointer, this.capacity);
  }

  #groupPointer(group: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(group) || group < 0 || group >= this.groupCount) {
      throw new RangeError("group out of bounds");
    }
    return this.#allocation.pointer + group * GROUP_SIZE;
  }

  #checkSlot(slot: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.capacity) {
      throw new RangeError("slot out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("FingerprintTable16 has been disposed");
  }
}

function validateFingerprint(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7f) {
    throw new RangeError("fingerprint must be an integer between 0 and 127");
  }
}

function validateControl(value: number): void {
  if (value <= 0x7f || value === EMPTY || value === DELETED) return;
  throw new RangeError("control must be a fingerprint, empty, or deleted marker");
}
