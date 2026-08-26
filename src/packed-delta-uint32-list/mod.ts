import {
  at as wasmAt,
  decode_range as wasmDecodeRange,
  init_shuffle_table as wasmInitShuffleTable,
  intersect_into as wasmIntersectInto,
  lower_bound as wasmLowerBound,
  memory,
} from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";
import {
  copyMonotoneSource,
  MonotoneUint32Builder,
  type MonotoneUint32Source,
} from "../internal/monotone-uint32.ts";

export { MonotoneUint32Builder };
export type { MonotoneUint32Source };

const SHUFFLE_TABLE_BYTES = 4_096;
wasmInitShuffleTable(0);
const allocator = new LinearMemoryAllocator(memory, SHUFFLE_TABLE_BYTES);

interface EncodedStream {
  readonly controls: Uint8Array;
  readonly data: Uint8Array;
  /** Interleaved data offset and preceding absolute value for every block boundary. */
  readonly checkpoints: Uint32Array;
  readonly length: number;
}

/** Mutable strict-monotone construction state for a frozen packed list. */
export class PackedDeltaUint32ListBuilder {
  readonly #values: number[] = [];

  get length(): number {
    return this.#values.length;
  }

  append(value: number): this {
    const normalized = validateUint32(value);
    const previous = this.#values[this.#values.length - 1];
    if (previous !== undefined && normalized <= previous) {
      throw new RangeError("values must be strictly increasing");
    }
    this.#values.push(normalized);
    return this;
  }

  freeze(): PackedDeltaUint32List {
    return PackedDeltaUint32List.fromUint32Array(Uint32Array.from(this.#values));
  }
}

/** An immutable Stream-VByte delta list for strictly increasing Uint32 values. */
export class PackedDeltaUint32List {
  readonly length: number;
  readonly compressedBytes: number;
  readonly #controlsAllocation: Allocation;
  readonly #dataAllocation: Allocation;
  readonly #checkpointsAllocation: Allocation;
  #disposed = false;

  private constructor(encoded: EncodedStream) {
    this.length = encoded.length;
    this.compressedBytes = encoded.controls.byteLength + encoded.data.byteLength +
      encoded.checkpoints.byteLength;

    let controlsAllocation: Allocation | undefined;
    let dataAllocation: Allocation | undefined;
    let checkpointsAllocation: Allocation | undefined;
    try {
      controlsAllocation = allocator.allocate(encoded.controls.byteLength);
      dataAllocation = allocator.allocate(
        encoded.data.byteLength === 0 ? 0 : encoded.data.byteLength + 16,
      );
      checkpointsAllocation = allocator.allocate(encoded.checkpoints.byteLength);
      new Uint8Array(
        memory.buffer,
        controlsAllocation.pointer,
        encoded.controls.byteLength,
      ).set(encoded.controls);
      new Uint8Array(memory.buffer, dataAllocation.pointer, encoded.data.byteLength).set(
        encoded.data,
      );
      new Uint32Array(
        memory.buffer,
        checkpointsAllocation.pointer,
        encoded.checkpoints.length,
      ).set(encoded.checkpoints);
    } catch (error) {
      if (checkpointsAllocation !== undefined) allocator.release(checkpointsAllocation);
      if (dataAllocation !== undefined) allocator.release(dataAllocation);
      if (controlsAllocation !== undefined) allocator.release(controlsAllocation);
      throw error;
    }
    this.#controlsAllocation = controlsAllocation;
    this.#dataAllocation = dataAllocation;
    this.#checkpointsAllocation = checkpointsAllocation;
  }

  static from(values: Iterable<number>): PackedDeltaUint32List {
    const builder = new PackedDeltaUint32ListBuilder();
    for (const value of values) builder.append(value);
    return builder.freeze();
  }

  static fromUint32Array(values: Uint32Array): PackedDeltaUint32List {
    for (let index = 1; index < values.length; index++) {
      if (values[index]! <= values[index - 1]!) {
        throw new RangeError("values must be strictly increasing");
      }
    }
    return new PackedDeltaUint32List(encode(values));
  }

  /** Copies a strict-monotone source and freezes it into Stream-VByte delta form. */
  static fromMonotone(source: MonotoneUint32Source): PackedDeltaUint32List {
    return PackedDeltaUint32List.fromUint32Array(copyMonotoneSource(source));
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  at(index: number): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("index out of bounds");
    }
    return Number(
      wasmAt(
        this.#dataAllocation.pointer,
        this.#controlsAllocation.pointer,
        this.#checkpointsAllocation.pointer,
        index,
      ),
    );
  }

  lowerBound(value: number): number {
    this.#assertAlive();
    const target = validateUint32(value);
    return wasmLowerBound(
      this.#dataAllocation.pointer,
      this.#controlsAllocation.pointer,
      this.#checkpointsAllocation.pointer,
      this.length,
      target,
    );
  }

  nextGEQ(value: number): number {
    const index = this.lowerBound(value);
    return index === this.length ? -1 : this.at(index);
  }

  decodeInto(start: number, output: Uint32Array): number {
    this.#assertAlive();
    if (!Number.isSafeInteger(start) || start < 0 || start > this.length) {
      throw new RangeError("decode start out of bounds");
    }
    if (output.length === 0 || start === this.length) return 0;
    const scratch = allocator.allocate(output.byteLength);
    try {
      const count = wasmDecodeRange(
        this.#dataAllocation.pointer,
        this.#controlsAllocation.pointer,
        this.#checkpointsAllocation.pointer,
        this.length,
        start,
        scratch.pointer,
        output.length,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer, count), 0);
      return count;
    } finally {
      allocator.release(scratch);
    }
  }

  intersectInto(other: PackedDeltaUint32List, output: Uint32Array): number {
    this.#assertAlive();
    other.#assertAlive();
    if (output.length === 0 || this.length === 0 || other.length === 0) return 0;
    const scratch = allocator.allocate(output.byteLength);
    try {
      const count = wasmIntersectInto(
        this.#dataAllocation.pointer,
        this.#controlsAllocation.pointer,
        this.length,
        other.#dataAllocation.pointer,
        other.#controlsAllocation.pointer,
        other.length,
        scratch.pointer,
        output.length,
      );
      output.set(new Uint32Array(memory.buffer, scratch.pointer, count), 0);
      return count;
    } finally {
      allocator.release(scratch);
    }
  }

  toUint32Array(): Uint32Array {
    const output = new Uint32Array(this.length);
    this.decodeInto(0, output);
    return output;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#checkpointsAllocation);
    allocator.release(this.#dataAllocation);
    allocator.release(this.#controlsAllocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("PackedDeltaUint32List has been disposed");
  }
}

function encode(values: Uint32Array): EncodedStream {
  const controls = new Uint8Array(Math.ceil(values.length / 4));
  const data: number[] = [];
  const checkpoints: number[] = [];
  let previous = 0;

  for (let group = 0; group < controls.length; group++) {
    if ((group & 31) === 0) checkpoints.push(data.length, previous);
    let control = 0;
    for (let lane = 0; lane < 4; lane++) {
      const index = group * 4 + lane;
      const value = index < values.length ? values[index]! : previous;
      const delta = (value - previous) >>> 0;
      const byteLength = encodedByteLength(delta);
      control |= (byteLength - 1) << (lane * 2);
      for (let byte = 0; byte < byteLength; byte++) data.push((delta >>> (byte * 8)) & 0xff);
      if (index < values.length) previous = value;
    }
    controls[group] = control;
  }
  checkpoints.push(data.length, previous);

  return {
    controls,
    data: Uint8Array.from(data),
    checkpoints: Uint32Array.from(checkpoints),
    length: values.length,
  };
}

function encodedByteLength(value: number): number {
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xff_ffff) return 3;
  return 4;
}

function validateUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("value must be an unsigned 32-bit integer");
  }
  return value;
}
