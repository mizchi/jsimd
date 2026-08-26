import {
  decode as wasmDecode,
  equals as wasmEquals,
  equals_many as wasmEqualsMany,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const BLOCK_SHIFT = 4;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const allocator = new LinearMemoryAllocator(memory);

interface Layout {
  readonly anchorOffsets: Uint32Array;
  readonly prefixLengths: Uint32Array;
  readonly suffixOffsets: Uint32Array;
  readonly suffixLengths: Uint32Array;
  readonly arena: Uint8Array;
  readonly uncompressedBytes: number;
}

/** A frozen front-coded table for byte strings with SIMD equality over resident segments. */
export class CompressedStringTable {
  readonly length: number;
  readonly uncompressedBytes: number;
  readonly encodedBytes: number;
  readonly #allocation: Allocation;
  readonly #anchorOffsetsPointer: number;
  readonly #prefixLengthsPointer: number;
  readonly #suffixOffsetsPointer: number;
  readonly #suffixLengthsPointer: number;
  readonly #arenaPointer: number;
  #disposed = false;

  private constructor(layout: Layout) {
    this.length = layout.prefixLengths.length;
    this.uncompressedBytes = layout.uncompressedBytes;
    this.encodedBytes = layout.anchorOffsets.byteLength + layout.prefixLengths.byteLength +
      layout.suffixOffsets.byteLength + layout.suffixLengths.byteLength + layout.arena.byteLength;
    const anchorOffsetsOffset = 0;
    const prefixLengthsOffset = anchorOffsetsOffset + layout.anchorOffsets.byteLength;
    const suffixOffsetsOffset = prefixLengthsOffset + layout.prefixLengths.byteLength;
    const suffixLengthsOffset = suffixOffsetsOffset + layout.suffixOffsets.byteLength;
    const arenaOffset = suffixLengthsOffset + layout.suffixLengths.byteLength;
    this.#allocation = allocator.allocate(arenaOffset + layout.arena.byteLength);
    this.#anchorOffsetsPointer = this.#allocation.pointer + anchorOffsetsOffset;
    this.#prefixLengthsPointer = this.#allocation.pointer + prefixLengthsOffset;
    this.#suffixOffsetsPointer = this.#allocation.pointer + suffixOffsetsOffset;
    this.#suffixLengthsPointer = this.#allocation.pointer + suffixLengthsOffset;
    this.#arenaPointer = this.#allocation.pointer + arenaOffset;
    try {
      new Uint32Array(memory.buffer, this.#anchorOffsetsPointer, layout.anchorOffsets.length).set(
        layout.anchorOffsets,
      );
      new Uint32Array(memory.buffer, this.#prefixLengthsPointer, this.length).set(
        layout.prefixLengths,
      );
      new Uint32Array(memory.buffer, this.#suffixOffsetsPointer, this.length).set(
        layout.suffixOffsets,
      );
      new Uint32Array(memory.buffer, this.#suffixLengthsPointer, this.length).set(
        layout.suffixLengths,
      );
      new Uint8Array(memory.buffer, this.#arenaPointer, layout.arena.length).set(layout.arena);
    } catch (error) {
      allocator.release(this.#allocation);
      throw error;
    }
  }

  static from(strings: Iterable<Uint8Array>): CompressedStringTable {
    return new CompressedStringTable(buildLayout(strings));
  }

  static fromUtf8(strings: Iterable<string>): CompressedStringTable {
    const encoder = new TextEncoder();
    return CompressedStringTable.from(Array.from(strings, (value) => encoder.encode(value)));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  byteLengthAt(id: number): number {
    this.#checkId(id);
    const prefixes = new Uint32Array(memory.buffer, this.#prefixLengthsPointer, this.length);
    const suffixes = new Uint32Array(memory.buffer, this.#suffixLengthsPointer, this.length);
    return prefixes[id]! + suffixes[id]!;
  }

  get(id: number): Uint8Array {
    const output = new Uint8Array(this.byteLengthAt(id));
    this.decodeInto(id, output);
    return output;
  }

  decodeInto(id: number, output: Uint8Array): number {
    const length = this.byteLengthAt(id);
    if (!(output instanceof Uint8Array) || output.length < length) {
      throw new RangeError("output is too short for the decoded string");
    }
    const scratch = allocator.allocate(length);
    try {
      wasmDecode(...this.#base(), id, scratch.pointer);
      output.set(new Uint8Array(memory.buffer, scratch.pointer, length).slice(), 0);
      return length;
    } finally {
      allocator.release(scratch);
    }
  }

  equals(id: number, query: Uint8Array): boolean {
    this.#checkId(id);
    if (!(query instanceof Uint8Array)) throw new TypeError("query must be a Uint8Array");
    const scratch = allocator.allocate(query.length);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, query.length).set(query);
      return wasmEquals(...this.#base(), id, scratch.pointer, query.length) !== 0;
    } finally {
      allocator.release(scratch);
    }
  }

  equalsMany(
    ids: Uint32Array,
    queries: Uint8Array,
    offsets: Uint32Array,
    output: Uint8Array = new Uint8Array(ids.length),
  ): Uint8Array {
    this.#assertAlive();
    if (!(ids instanceof Uint32Array)) throw new TypeError("ids must be a Uint32Array");
    const count = validateBatch(queries, offsets);
    if (count !== ids.length || !(output instanceof Uint8Array) || output.length !== count) {
      throw new RangeError("ids, queries, and output lengths must match");
    }
    for (const id of ids) this.#checkId(id);
    if (count === 0) return output;
    const queriesOffset = ids.byteLength;
    const offsetsOffset = align4(queriesOffset + queries.byteLength);
    const outputOffset = offsetsOffset + offsets.byteLength;
    const scratch = allocator.allocate(outputOffset + output.byteLength);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, ids.length).set(ids);
      new Uint8Array(memory.buffer, scratch.pointer + queriesOffset, queries.length).set(queries);
      new Uint32Array(memory.buffer, scratch.pointer + offsetsOffset, offsets.length).set(offsets);
      wasmEqualsMany(
        ...this.#base(),
        scratch.pointer,
        scratch.pointer + queriesOffset,
        scratch.pointer + offsetsOffset,
        count,
        scratch.pointer + outputOffset,
      );
      output.set(new Uint8Array(memory.buffer, scratch.pointer + outputOffset, count));
      return output;
    } finally {
      allocator.release(scratch);
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #base(): [number, number, number, number, number] {
    this.#assertAlive();
    return [
      this.#anchorOffsetsPointer,
      this.#prefixLengthsPointer,
      this.#suffixOffsetsPointer,
      this.#suffixLengthsPointer,
      this.#arenaPointer,
    ];
  }

  #checkId(id: number): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.length) {
      throw new RangeError("string id out of bounds");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("CompressedStringTable has been disposed");
  }
}

function buildLayout(input: Iterable<Uint8Array>): Layout {
  const strings = Array.from(input, (value) => {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("strings must contain Uint8Array values");
    }
    return value.slice();
  });
  const blockCount = Math.ceil(strings.length / BLOCK_SIZE);
  const anchorOffsets = new Uint32Array(blockCount);
  const prefixLengths = new Uint32Array(strings.length);
  const suffixOffsets = new Uint32Array(strings.length);
  const suffixLengths = new Uint32Array(strings.length);
  const segments: Uint8Array[] = [];
  let arenaLength = 0;
  let uncompressedBytes = 0;
  for (let block = 0; block < blockCount; block++) {
    const first = block << BLOCK_SHIFT;
    const anchor = strings[first]!;
    anchorOffsets[block] = arenaLength;
    segments.push(anchor);
    arenaLength += anchor.length;
    for (let id = first; id < Math.min(first + BLOCK_SIZE, strings.length); id++) {
      const value = strings[id]!;
      uncompressedBytes += value.length;
      const prefix = id === first ? 0 : commonPrefix(anchor, value);
      const suffix = value.subarray(prefix);
      prefixLengths[id] = prefix;
      if (id === first) {
        suffixOffsets[id] = anchorOffsets[block]!;
      } else {
        suffixOffsets[id] = arenaLength;
        segments.push(suffix);
        arenaLength += suffix.length;
      }
      suffixLengths[id] = suffix.length;
      if (arenaLength > 0xffff_ffff) throw new RangeError("compressed string arena is too large");
    }
  }
  const arena = new Uint8Array(arenaLength);
  let cursor = 0;
  for (const segment of segments) {
    arena.set(segment, cursor);
    cursor += segment.length;
  }
  return { anchorOffsets, prefixLengths, suffixOffsets, suffixLengths, arena, uncompressedBytes };
}

function commonPrefix(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index++;
  return index;
}

function validateBatch(queries: Uint8Array, offsets: Uint32Array): number {
  if (!(queries instanceof Uint8Array)) throw new TypeError("queries must be a Uint8Array");
  if (!(offsets instanceof Uint32Array) || offsets.length === 0 || offsets[0] !== 0) {
    throw new RangeError("offsets must start with zero");
  }
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index]! < offsets[index - 1]!) throw new RangeError("offsets must be monotone");
  }
  if (offsets[offsets.length - 1] !== queries.length) {
    throw new RangeError("the final offset must equal queries.length");
  }
  return offsets.length - 1;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}
