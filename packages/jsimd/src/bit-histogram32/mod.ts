import { add as wasmAdd, memory } from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";

const COUNTS = 32;
const COUNTER_BYTES = COUNTS * 4;
const SCRATCH_BYTES = 32;
const MAX_LENGTH = 0xffff_ffff;
const allocator = new LinearMemoryAllocator(memory);

/** A streaming positional-popcount accumulator for unsigned 32-bit words. */
export class BitHistogram32 {
  #allocation: Allocation;
  #disposed = false;
  #length = 0;

  constructor() {
    const allocation = allocator.allocate(COUNTER_BYTES);
    try {
      new Uint32Array(memory.buffer, allocation.pointer, COUNTS).fill(0);
    } catch (error) {
      allocator.release(allocation);
      throw error;
    }
    this.#allocation = allocation;
  }

  get length(): number {
    this.#assertAlive();
    return this.#length;
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  add(values: Uint32Array): this {
    this.#assertAlive();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (this.#length + values.length > MAX_LENGTH) {
      throw new RangeError("histogram length exceeds the unsigned 32-bit count range");
    }
    if (values.length === 0) return this;
    const inputBytes = values.byteLength;
    const scratch = allocator.allocate(inputBytes + SCRATCH_BYTES);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, values.length).set(values);
      wasmAdd(
        scratch.pointer,
        values.length,
        this.#allocation.pointer,
        scratch.pointer + inputBytes,
        scratch.pointer + inputBytes + 16,
      );
      this.#length += values.length;
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  writeInto(output: Uint32Array): Uint32Array {
    this.#assertAlive();
    if (!(output instanceof Uint32Array) || output.length < COUNTS) {
      throw new RangeError("output must be a Uint32Array with at least 32 counters");
    }
    output.set(new Uint32Array(memory.buffer, this.#allocation.pointer, COUNTS));
    return output;
  }

  reset(): this {
    this.#assertAlive();
    new Uint32Array(memory.buffer, this.#allocation.pointer, COUNTS).fill(0);
    this.#length = 0;
    return this;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("BitHistogram32 has been disposed");
  }
}

/** Counts each of the 32 bit positions across `values` into caller-owned output. */
export function bitHistogram32(values: Uint32Array, output: Uint32Array): Uint32Array {
  using histogram = new BitHistogram32();
  return histogram.add(values).writeInto(output);
}
