export const DEFAULT_WASM_PIXEL_BLOCK_SEED = 0x51f1_5e5d;

interface PixelBlockKernelExports extends WebAssembly.Exports {
  step(cells: number, width: number, height: number, tick: number, seed: number): number;
  step_range(
    cells: number,
    width: number,
    height: number,
    tick: number,
    seed: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): bigint;
}

export interface PixelBlockKernelRangeResult {
  readonly moves: number;
  readonly hot: boolean;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Owns a row-major u32 world in Wasm memory and advances four adjacent blocks per SIMD group. */
export class WasmSimdPixelBlock {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly memory: WebAssembly.Memory;
  readonly cells: Uint32Array;
  readonly #kernel: PixelBlockKernelExports;

  private constructor(
    width: number,
    height: number,
    memory: WebAssembly.Memory,
    kernel: PixelBlockKernelExports,
  ) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.memory = memory;
    this.cells = new Uint32Array(memory.buffer, 0, this.cellCount);
    this.#kernel = kernel;
  }

  static async create(
    width: number,
    height: number,
    minimumMemoryBytes = width * height * Uint32Array.BYTES_PER_ELEMENT,
  ): Promise<WasmSimdPixelBlock> {
    validateDimensions(width, height);
    const cellCount = width * height;
    const cellBytes = cellCount * Uint32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(minimumMemoryBytes) || minimumMemoryBytes < cellBytes) {
      throw new RangeError(`pixel block memory must contain at least ${cellBytes} bytes`);
    }
    const pages = Math.max(1, Math.ceil(minimumMemoryBytes / 65_536));
    const memory = new WebAssembly.Memory({ initial: pages });
    modulePromise ??= compileModule(new URL("./pixel_block_step.wasm", import.meta.url));
    const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
    return new WasmSimdPixelBlock(
      width,
      height,
      memory,
      instance.exports as PixelBlockKernelExports,
    );
  }

  set(cells: Uint32Array): void {
    if (cells.length !== this.cellCount) {
      throw new RangeError(`pixel block input must contain ${this.cellCount} cells`);
    }
    this.cells.set(cells);
  }

  step(tick: number, seed = DEFAULT_WASM_PIXEL_BLOCK_SEED): number {
    nonNegativeSafeInteger(tick, "tick");
    uint32(seed, "seed");
    return this.#kernel.step(0, this.width, this.height, tick, seed) >>> 0;
  }

  stepRange(
    tick: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    seed = DEFAULT_WASM_PIXEL_BLOCK_SEED,
  ): PixelBlockKernelRangeResult {
    nonNegativeSafeInteger(tick, "tick");
    uint32(seed, "seed");
    validateRange(left, top, right, bottom, this.width, this.height);
    const packed = this.#kernel.step_range(
      0,
      this.width,
      this.height,
      tick,
      seed,
      left,
      top,
      right,
      bottom,
    );
    return {
      moves: Number(packed & 0xffff_ffffn) >>> 0,
      hot: packed >> 32n !== 0n,
    };
  }
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Wasm SIMD pixel block dimensions must be positive safe integers");
  }
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || cellCount > 1_073_741_824) {
    throw new RangeError("Wasm SIMD pixel block world is too large");
  }
}

function validateRange(
  left: number,
  top: number,
  right: number,
  bottom: number,
  width: number,
  height: number,
): void {
  for (
    const [value, name] of [[left, "left"], [top, "top"], [right, "right"], [
      bottom,
      "bottom",
    ]] as const
  ) {
    nonNegativeSafeInteger(value, name);
  }
  if (left > right || top > bottom || right > width || bottom > height) {
    throw new RangeError("pixel block range must be a valid half-open world range");
  }
}

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function uint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load pixel block Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
