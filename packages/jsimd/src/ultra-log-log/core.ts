import { add_u32_many as wasmAddMany, memory, merge_state as wasmMergeState } from "./kernels.wasm";
import {
  type Allocation,
  type AllocatorStats,
  LinearMemoryAllocator,
} from "../internal/allocator.ts";
import { estimateUltraLogLog } from "./estimator.ts";

const MIN_PRECISION = 3;
const MAX_PRECISION = 20;
const WASM_ADD_THRESHOLD = 16_384;
const MAX_INPUT_LENGTH = 0x0fff_ffff;
const allocator = new LinearMemoryAllocator(memory);

export type UltraLogLogAddStrategy = "javascript" | "wasm";

/** Mutable approximate distinct counter with exact mergeable eight-bit register state. */
export class UltraLogLogU32 implements Disposable {
  static readonly wasmAddThreshold = WASM_ADD_THRESHOLD;

  readonly precision: number;
  readonly registerCount: number;
  readonly byteLength: number;
  readonly #allocation: Allocation;
  #lastAddStrategy: UltraLogLogAddStrategy | null = null;
  #disposed = false;

  constructor(precision = 14) {
    validatePrecision(precision);
    this.precision = precision;
    this.registerCount = 1 << precision;
    this.byteLength = this.registerCount;
    this.#allocation = allocator.allocate(this.byteLength);
  }

  static from(values: Uint32Array, precision = 14): UltraLogLogU32 {
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    const sketch = new UltraLogLogU32(precision);
    try {
      return sketch.addMany(values);
    } catch (error) {
      sketch[Symbol.dispose]();
      throw error;
    }
  }

  static fromState(state: Uint8Array): UltraLogLogU32 {
    if (!(state instanceof Uint8Array)) throw new TypeError("state must be a Uint8Array");
    const precision = Math.log2(state.length);
    validatePrecision(precision);
    const sketch = new UltraLogLogU32(precision);
    try {
      sketch.setState(state);
      return sketch;
    } catch (error) {
      sketch[Symbol.dispose]();
      throw error;
    }
  }

  static allocatorStats(): AllocatorStats {
    return allocator.stats();
  }

  get lastAddStrategy(): UltraLogLogAddStrategy | null {
    this.#assertAlive();
    return this.#lastAddStrategy;
  }

  add(value: number): this {
    this.#assertAlive();
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError("value must be an unsigned 32-bit integer");
    }
    addU32ToState(this.#stateView(), this.precision, value);
    this.#lastAddStrategy = "javascript";
    return this;
  }

  addMany(values: Uint32Array): this {
    this.#assertAlive();
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (values.length > MAX_INPUT_LENGTH) throw new RangeError("values exceed Wasm input capacity");
    if (values.length < WASM_ADD_THRESHOLD) {
      const state = this.#stateView();
      for (let index = 0; index < values.length; index++) {
        addU32ToState(state, this.precision, values[index]!);
      }
      this.#lastAddStrategy = "javascript";
      return this;
    }
    const scratch = allocator.allocate(values.byteLength);
    try {
      new Uint32Array(memory.buffer, scratch.pointer, values.length).set(values);
      wasmAddMany(this.#allocation.pointer, this.precision, scratch.pointer, values.length);
      this.#lastAddStrategy = "wasm";
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  replace(values: Uint32Array): this {
    return this.reset().addMany(values);
  }

  merge(other: UltraLogLogU32): this {
    this.#assertAlive();
    other.#assertAlive();
    if (other.precision !== this.precision) throw new RangeError("precision mismatch");
    wasmMergeState(this.#allocation.pointer, other.#allocation.pointer, this.registerCount);
    return this;
  }

  mergeState(state: Uint8Array): this {
    this.#assertAlive();
    assertState(state, this.registerCount);
    const scratch = allocator.allocate(this.registerCount);
    try {
      new Uint8Array(memory.buffer, scratch.pointer, this.registerCount).set(state);
      wasmMergeState(this.#allocation.pointer, scratch.pointer, this.registerCount);
      return this;
    } finally {
      allocator.release(scratch);
    }
  }

  setState(state: Uint8Array): this {
    this.#assertAlive();
    assertState(state, this.registerCount);
    this.#stateView().set(state);
    this.#lastAddStrategy = null;
    return this;
  }

  state(): Uint8Array {
    this.#assertAlive();
    return this.#stateView().slice();
  }

  stateInto(output: Uint8Array): void {
    this.#assertAlive();
    if (!(output instanceof Uint8Array) || output.length < this.registerCount) {
      throw new RangeError("output must cover every register");
    }
    output.set(this.#stateView());
  }

  estimate(): number {
    this.#assertAlive();
    return estimateUltraLogLog(this.#stateView(), this.precision);
  }

  reset(): this {
    this.#assertAlive();
    this.#stateView().fill(0);
    this.#lastAddStrategy = null;
    return this;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    allocator.release(this.#allocation);
  }

  #stateView(): Uint8Array {
    return new Uint8Array(memory.buffer, this.#allocation.pointer, this.registerCount);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("UltraLogLogU32 has been disposed");
  }
}

function addU32ToState(state: Uint8Array, precision: number, value: number): void {
  const high = mix32((value ^ 0x9e37_79b9) >>> 0);
  const low = mix32((value ^ 0x85eb_ca6b) >>> 0);
  const index = high >>> (32 - precision);
  const shiftedHigh = ((high << precision) | (low >>> (32 - precision))) >>> 0;
  const shiftedLow = (low << precision) >>> 0;
  const leadingZeros = shiftedHigh !== 0
    ? Math.clz32(shiftedHigh)
    : Math.min(64 - precision, 32 + Math.clz32(shiftedLow));
  const event = ((precision - 1 + leadingZeros) << 2) & 0xff;
  state[index] = mergeRegister(state[index]!, event);
}

function mergeRegister(left: number, right: number): number {
  if (left === 0) return right;
  if (right === 0) return left;
  const leftRank = left >>> 2;
  const rightRank = right >>> 2;
  if (leftRank === rightRank) return (left & 0xfc) | ((left | right) & 3);
  const larger = leftRank > rightRank ? left : right;
  const smaller = leftRank > rightRank ? right : left;
  const difference = Math.abs(leftRank - rightRank);
  let history = larger & 3;
  if (difference === 1) history |= 2 | ((smaller >>> 1) & 1);
  else if (difference === 2) history |= 1;
  return (larger & 0xfc) | history;
}

function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x7feb_352d);
  hash = Math.imul(hash ^ hash >>> 15, 0x846c_a68b);
  return (hash ^ hash >>> 16) >>> 0;
}

function validatePrecision(precision: number): void {
  if (!Number.isSafeInteger(precision) || precision < MIN_PRECISION || precision > MAX_PRECISION) {
    throw new RangeError(`precision must be between ${MIN_PRECISION} and ${MAX_PRECISION}`);
  }
}

function assertState(state: Uint8Array, registerCount: number): void {
  if (!(state instanceof Uint8Array) || state.length !== registerCount) {
    throw new RangeError("state length does not match precision");
  }
}
