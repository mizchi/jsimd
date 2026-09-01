import { instantiatePatchTapeKernel, type PatchTapeKernel } from "./patch_tape_kernel.ts";

const WASM_PAGE_BYTES = 65_536;

export type PatchBinding =
  | { readonly kind: "text-i32"; readonly target: number }
  | { readonly kind: "boolean-property"; readonly target: number; readonly name: string }
  | { readonly kind: "style-f32"; readonly target: number; readonly name: string };

export interface PatchStyle {
  setProperty(name: string, value: string): void;
}

export interface PatchTarget {
  data?: string;
  style?: PatchStyle;
  [name: string]: unknown;
}

export interface PatchBatch {
  /** Borrowed until the next drain on the same tape. */
  readonly bindingIds: Uint32Array;
  /** Raw i32/f32 bits, borrowed until the next drain on the same tape. */
  readonly values: Uint32Array;
  /** Floating-point projection of values over the same borrowed bytes. */
  readonly f32Values: Float32Array;
}

export interface NumericPatchTapeOptions {
  readonly wasm?: boolean;
}

interface Layout {
  readonly current: number;
  readonly previous: number;
  readonly outputIds: number;
  readonly outputValues: number;
  readonly byteLength: number;
}

/** Fixed-width numeric binding state and a compact changed-value command tape. */
export class NumericPatchTape {
  readonly bindingCount: number;
  lastStrategy: "simd" | "scalar" | null = null;
  readonly #memory: WebAssembly.Memory;
  readonly #layout: Layout;
  readonly #kernel: PatchTapeKernel | null;
  readonly #currentU32: Uint32Array;
  readonly #currentI32: Int32Array;
  readonly #currentF32: Float32Array;
  readonly #previousU32: Uint32Array;
  #initialDrain = true;

  private constructor(
    bindingCount: number,
    memory: WebAssembly.Memory,
    layout: Layout,
    kernel: PatchTapeKernel | null,
  ) {
    this.bindingCount = bindingCount;
    this.#memory = memory;
    this.#layout = layout;
    this.#kernel = kernel;
    this.#currentU32 = new Uint32Array(memory.buffer, layout.current, bindingCount);
    this.#currentI32 = new Int32Array(memory.buffer, layout.current, bindingCount);
    this.#currentF32 = new Float32Array(memory.buffer, layout.current, bindingCount);
    this.#previousU32 = new Uint32Array(memory.buffer, layout.previous, bindingCount);
  }

  static async create(
    bindings: readonly PatchBinding[],
    options: NumericPatchTapeOptions = {},
  ): Promise<NumericPatchTape> {
    validateBindings(bindings);
    const layout = createLayout(bindings.length);
    const pages = Math.max(1, Math.ceil(layout.byteLength / WASM_PAGE_BYTES));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const kernel = options.wasm === false
      ? null
      : await instantiatePatchTapeKernel(memory).catch(() => null);
    return new NumericPatchTape(bindings.length, memory, layout, kernel);
  }

  setI32(bindingId: number, value: number): void {
    this.#checkBindingId(bindingId);
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new RangeError("value must be a signed 32-bit integer");
    }
    this.#currentI32[bindingId] = value;
  }

  setBoolean(bindingId: number, value: boolean): void {
    this.#checkBindingId(bindingId);
    if (typeof value !== "boolean") throw new TypeError("value must be boolean");
    this.#currentU32[bindingId] = value ? 1 : 0;
  }

  setF32(bindingId: number, value: number): void {
    this.#checkBindingId(bindingId);
    if (typeof value !== "number") throw new TypeError("value must be a number");
    this.#currentF32[bindingId] = value;
  }

  /** Mutable compiler-facing view. Values written here are observed by the next drain. */
  get i32Values(): Int32Array {
    return this.#currentI32;
  }

  /** Mutable compiler-facing f32 projection over the same bytes as i32Values. */
  get f32Values(): Float32Array {
    return this.#currentF32;
  }

  drain(): PatchBatch {
    if (this.#initialDrain) {
      for (let bindingId = 0; bindingId < this.bindingCount; bindingId++) {
        this.#previousU32[bindingId] = (~this.#currentU32[bindingId]!) >>> 0;
      }
      this.#initialDrain = false;
    }
    const count = this.#kernel === null ? this.#drainScalar() : this.#drainSimd();
    const bindingIds = new Uint32Array(this.#memory.buffer, this.#layout.outputIds, count);
    const values = new Uint32Array(this.#memory.buffer, this.#layout.outputValues, count);
    return {
      bindingIds,
      values,
      f32Values: new Float32Array(values.buffer, values.byteOffset, values.length),
    };
  }

  #drainSimd(): number {
    this.lastStrategy = "simd";
    return this.#kernel!.collect_changed(
      this.#layout.current,
      this.#layout.previous,
      this.bindingCount,
      this.#layout.outputIds,
      this.#layout.outputValues,
    );
  }

  #drainScalar(): number {
    this.lastStrategy = "scalar";
    const ids = new Uint32Array(this.#memory.buffer, this.#layout.outputIds, this.bindingCount);
    const values = new Uint32Array(
      this.#memory.buffer,
      this.#layout.outputValues,
      this.bindingCount,
    );
    let count = 0;
    for (let bindingId = 0; bindingId < this.bindingCount; bindingId++) {
      const value = this.#currentU32[bindingId]!;
      if (value === this.#previousU32[bindingId]) continue;
      this.#previousU32[bindingId] = value;
      ids[count] = bindingId;
      values[count++] = value;
    }
    return count;
  }

  #checkBindingId(bindingId: number): void {
    if (!Number.isSafeInteger(bindingId) || bindingId < 0 || bindingId >= this.bindingCount) {
      throw new RangeError("binding ID out of bounds");
    }
  }
}

/** Applies a borrowed batch. Static strings and target objects stay outside Wasm memory. */
export function applyPatchBatch(
  batch: PatchBatch,
  bindings: readonly PatchBinding[],
  targets: readonly PatchTarget[],
): number {
  for (let index = 0; index < batch.bindingIds.length; index++) {
    const bindingId = batch.bindingIds[index]!;
    const binding = bindings[bindingId];
    if (binding === undefined) throw new RangeError("binding ID out of bounds");
    const target = targets[binding.target];
    if (target === undefined) throw new RangeError("patch target out of bounds");
    switch (binding.kind) {
      case "text-i32":
        target.data = String(batch.values[index]! | 0);
        break;
      case "boolean-property":
        target[binding.name] = batch.values[index] !== 0;
        break;
      case "style-f32": {
        const style = target.style;
        if (style === undefined) throw new TypeError("style target required");
        style.setProperty(binding.name, String(batch.f32Values[index]!));
        break;
      }
    }
  }
  return batch.bindingIds.length;
}

/** Fast homogeneous lane: binding IDs directly index CharacterData-like targets. */
export function applyTextI32Batch(
  batch: PatchBatch,
  targets: readonly { data: string }[],
): number {
  for (let index = 0; index < batch.bindingIds.length; index++) {
    const target = targets[batch.bindingIds[index]!]!;
    target.data = String(batch.values[index]! | 0);
  }
  return batch.bindingIds.length;
}

function validateBindings(bindings: readonly PatchBinding[]): void {
  if (!Array.isArray(bindings)) throw new TypeError("bindings must be an array");
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null) throw new TypeError("invalid binding");
    if (
      !Number.isSafeInteger(binding.target) || binding.target < 0 || binding.target > 0xffff_ffff
    ) {
      throw new RangeError("binding target must be an unsigned 32-bit integer");
    }
    if (binding.kind === "text-i32") continue;
    if (binding.kind !== "boolean-property" && binding.kind !== "style-f32") {
      throw new TypeError("unknown patch binding kind");
    }
    if (typeof binding.name !== "string" || binding.name.length === 0) {
      throw new TypeError("binding name required");
    }
  }
}

function createLayout(bindingCount: number): Layout {
  const current = 0;
  const previous = alignTo(current + bindingCount * 4, 16);
  const outputIds = alignTo(previous + bindingCount * 4, 16);
  const outputValues = alignTo(outputIds + bindingCount * 4, 16);
  return {
    current,
    previous,
    outputIds,
    outputValues,
    byteLength: outputValues + bindingCount * 4,
  };
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
