import { WasmActiveSimdPixelBlock } from "../pixel_block_active_kernel.ts";
import { DEFAULT_WASM_PIXEL_BLOCK_SEED } from "../pixel_block_kernel.ts";

export class ActiveSimdBlockPixelSimulation {
  readonly #simulation: WasmActiveSimdPixelBlock;

  private constructor(simulation: WasmActiveSimdPixelBlock) {
    this.#simulation = simulation;
  }

  static async create(
    cells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_WASM_PIXEL_BLOCK_SEED,
  ): Promise<ActiveSimdBlockPixelSimulation> {
    return new ActiveSimdBlockPixelSimulation(
      await WasmActiveSimdPixelBlock.create(cells, width, height, seed),
    );
  }

  step(tick: number): number {
    return this.#simulation.step(tick).activeChunks;
  }

  activateRect(left: number, top: number, right: number, bottom: number): void {
    this.#simulation.activateRect(left, top, right, bottom);
  }

  get cells(): Uint32Array {
    return this.#simulation.cells;
  }

  get activeChunkCount(): number {
    return this.#simulation.activeChunkCount;
  }

  get chunkCount(): number {
    return this.#simulation.chunkCount;
  }

  get residentBytes(): number {
    return this.#simulation.residentBytes;
  }
}
