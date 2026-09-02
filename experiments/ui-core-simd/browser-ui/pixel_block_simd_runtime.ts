import { DEFAULT_WASM_PIXEL_BLOCK_SEED, WasmSimdPixelBlock } from "../pixel_block_kernel.ts";

export class SimdBlockPixelSimulation {
  readonly #kernel: WasmSimdPixelBlock;
  readonly #seed: number;

  private constructor(kernel: WasmSimdPixelBlock, seed: number) {
    this.#kernel = kernel;
    this.#seed = seed;
  }

  static async create(
    cells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_WASM_PIXEL_BLOCK_SEED,
  ): Promise<SimdBlockPixelSimulation> {
    const kernel = await WasmSimdPixelBlock.create(width, height);
    kernel.set(cells);
    return new SimdBlockPixelSimulation(kernel, seed);
  }

  step(tick: number): number {
    return this.#kernel.step(tick, this.#seed);
  }

  get cells(): Uint32Array {
    return this.#kernel.cells;
  }

  get residentBytes(): number {
    return this.#kernel.memory.buffer.byteLength;
  }
}
