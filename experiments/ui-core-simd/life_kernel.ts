interface LifeKernelExports extends WebAssembly.Exports {
  step(current: number, next: number, width: number, height: number): number;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export type LifeRuntime = "scalar" | "simd";

export class WasmSimdLife {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  readonly memory: WebAssembly.Memory;
  readonly #kernel: LifeKernelExports;
  readonly #boards: readonly [Uint8Array, Uint8Array];
  #currentIndex: 0 | 1 = 0;

  private constructor(
    width: number,
    height: number,
    memory: WebAssembly.Memory,
    kernel: LifeKernelExports,
  ) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.memory = memory;
    this.#kernel = kernel;
    this.#boards = [
      new Uint8Array(memory.buffer, 0, this.cellCount),
      new Uint8Array(memory.buffer, this.cellCount, this.cellCount),
    ];
  }

  static async create(width: number, height: number): Promise<WasmSimdLife> {
    validateDimensions(width, height);
    const cellCount = width * height;
    const pages = Math.max(1, Math.ceil(cellCount * 2 / 65_536));
    const memory = new WebAssembly.Memory({ initial: pages });
    modulePromise ??= compileModule(new URL("./life_step.wasm", import.meta.url));
    const instance = await WebAssembly.instantiate(await modulePromise, { jsimd: { memory } });
    return new WasmSimdLife(width, height, memory, instance.exports as LifeKernelExports);
  }

  get cells(): Uint8Array {
    return this.#boards[this.#currentIndex];
  }

  set(cells: Uint8Array): void {
    if (cells.length !== this.cellCount) {
      throw new RangeError(`life input must contain ${this.cellCount} cells`);
    }
    this.#boards[this.#currentIndex].set(cells);
    this.#boards[1 - this.#currentIndex].fill(0);
  }

  step(): number {
    const nextIndex = (1 - this.#currentIndex) as 0 | 1;
    const live = this.#kernel.step(
      this.#currentIndex * this.cellCount,
      nextIndex * this.cellCount,
      this.width,
      this.height,
    );
    this.#currentIndex = nextIndex;
    return live >>> 0;
  }
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height <= 0 ||
    width % 16 !== 0
  ) {
    throw new RangeError("Wasm SIMD Life requires a positive height and a width divisible by 16");
  }
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || cellCount > 1_073_741_824) {
    throw new RangeError("Wasm SIMD Life grid is too large");
  }
}

async function compileModule(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "file:") {
    const deno = (globalThis as { Deno?: { readFile(path: URL): Promise<Uint8Array> } }).Deno;
    if (deno === undefined) throw new Error("file: Wasm loading requires Deno");
    return await WebAssembly.compile(await deno.readFile(url) as BufferSource);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load Life Wasm module: ${response.status}`);
  return await WebAssembly.compile(await response.arrayBuffer());
}
