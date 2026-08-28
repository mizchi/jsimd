import { estimateUltraLogLog } from "./reference.ts";

const WASM_PAGE_BYTES = 65_536;
const MAX_WASM_BYTES = 0xffff_0000;

interface UltraLogLogKernels extends WebAssembly.Exports {
  build_u32(state: number, precision: number, values: number, length: number): void;
  merge_states(output: number, states: number, shardCount: number, registerCount: number): void;
}

export interface UltraLogLogWorkspaceOptions {
  readonly precision: number;
  readonly maxValues: number;
  readonly shardCapacity: number;
}

interface Layout {
  readonly mergedOffset: number;
  readonly valuesOffset: number;
  readonly byteLength: number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Fixed-memory workspace for independent ULL shards and exact SIMD state merge. */
export class UltraLogLogWorkspace implements Disposable, AsyncDisposable {
  readonly precision: number;
  readonly registerCount: number;
  readonly maxValues: number;
  readonly shardCapacity: number;
  readonly byteLength: number;
  readonly #memory: WebAssembly.Memory;
  readonly #kernels: UltraLogLogKernels;
  readonly #layout: Layout;
  #disposed = false;

  private constructor(
    options: UltraLogLogWorkspaceOptions,
    memory: WebAssembly.Memory,
    kernels: UltraLogLogKernels,
    layout: Layout,
  ) {
    this.precision = options.precision;
    this.registerCount = 1 << options.precision;
    this.maxValues = options.maxValues;
    this.shardCapacity = options.shardCapacity;
    this.byteLength = layout.byteLength;
    this.#memory = memory;
    this.#kernels = kernels;
    this.#layout = layout;
  }

  static async create(options: UltraLogLogWorkspaceOptions): Promise<UltraLogLogWorkspace> {
    validateOptions(options);
    const registerCount = 1 << options.precision;
    const mergedOffset = align16(registerCount * options.shardCapacity);
    const valuesOffset = align16(mergedOffset + registerCount);
    const byteLength = valuesOffset + options.maxValues * Uint32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_WASM_BYTES) {
      throw new RangeError("workspace exceeds the WebAssembly 32-bit memory limit");
    }
    const layout = { mergedOffset, valuesOffset, byteLength };
    const pages = Math.max(1, Math.ceil(byteLength / WASM_PAGE_BYTES));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const module = await compileModule();
    const instance = new WebAssembly.Instance(module, { jsimd: { memory } });
    return new UltraLogLogWorkspace(
      options,
      memory,
      instance.exports as UltraLogLogKernels,
      layout,
    );
  }

  buildShard(shardIndex: number, values: Uint32Array): void {
    this.#assertAlive();
    this.#assertShard(shardIndex);
    if (!(values instanceof Uint32Array)) throw new TypeError("values must be a Uint32Array");
    if (values.length > this.maxValues) throw new RangeError("values exceed workspace capacity");
    new Uint32Array(this.#memory.buffer, this.#layout.valuesOffset, values.length).set(values);
    this.#kernels.build_u32(
      shardIndex * this.registerCount,
      this.precision,
      this.#layout.valuesOffset,
      values.length,
    );
  }

  /** Copies a Worker-local or persisted state into a merge shard. */
  setShardState(shardIndex: number, state: Uint8Array): void {
    this.#assertAlive();
    this.#assertShard(shardIndex);
    if (!(state instanceof Uint8Array) || state.length !== this.registerCount) {
      throw new RangeError("state length does not match workspace precision");
    }
    new Uint8Array(
      this.#memory.buffer,
      shardIndex * this.registerCount,
      this.registerCount,
    ).set(state);
  }

  shardStateInto(shardIndex: number, output: Uint8Array): void {
    this.#assertAlive();
    this.#assertShard(shardIndex);
    assertOutput(output, this.registerCount);
    output.set(
      new Uint8Array(this.#memory.buffer, shardIndex * this.registerCount, this.registerCount),
    );
  }

  mergeInto(shardCount: number, output: Uint8Array): void {
    this.#assertAlive();
    if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > this.shardCapacity) {
      throw new RangeError("shardCount must be within workspace capacity");
    }
    assertOutput(output, this.registerCount);
    this.#kernels.merge_states(this.#layout.mergedOffset, 0, shardCount, this.registerCount);
    output.set(
      new Uint8Array(this.#memory.buffer, this.#layout.mergedOffset, this.registerCount),
    );
  }

  estimateShard(shardIndex: number): number {
    this.#assertAlive();
    this.#assertShard(shardIndex);
    return estimateUltraLogLog(
      new Uint8Array(this.#memory.buffer, shardIndex * this.registerCount, this.registerCount),
      this.precision,
    );
  }

  estimate(state: Uint8Array): number {
    this.#assertAlive();
    if (!(state instanceof Uint8Array) || state.length !== this.registerCount) {
      throw new RangeError("state length does not match workspace precision");
    }
    return estimateUltraLogLog(state, this.precision);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    new Uint8Array(this.#memory.buffer).fill(0);
  }

  [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
    return Promise.resolve();
  }

  #assertShard(shardIndex: number): void {
    if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= this.shardCapacity) {
      throw new RangeError("shard index is outside workspace capacity");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("UltraLogLogWorkspace has been disposed");
  }
}

function validateOptions(options: UltraLogLogWorkspaceOptions): void {
  if (!Number.isSafeInteger(options.precision) || options.precision < 3 || options.precision > 20) {
    throw new RangeError("precision must be between 3 and 20");
  }
  if (!Number.isSafeInteger(options.maxValues) || options.maxValues < 0) {
    throw new RangeError("maxValues must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(options.shardCapacity) || options.shardCapacity < 1 ||
    options.shardCapacity > 256
  ) {
    throw new RangeError("shardCapacity must be between 1 and 256");
  }
}

function assertOutput(output: Uint8Array, registerCount: number): void {
  if (!(output instanceof Uint8Array) || output.length < registerCount) {
    throw new RangeError("output must cover every register");
  }
}

function align16(value: number): number {
  return Math.ceil(value / 16) * 16;
}

async function compileModule(): Promise<WebAssembly.Module> {
  modulePromise ??= loadModuleBytes().then((bytes) => WebAssembly.compile(bytes));
  return await modulePromise;
}

async function loadModuleBytes(): Promise<BufferSource> {
  const url = new URL("./kernels.wasm", import.meta.url);
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(url: URL): Promise<Uint8Array> } }).Deno;
    if (deno) return await deno.readFile(url) as BufferSource;
    const { readFile } = await import("node:fs/promises");
    return await readFile(url) as BufferSource;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load UltraLogLog kernels: ${response.status}`);
  return await response.arrayBuffer();
}
