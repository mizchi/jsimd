import { DEFAULT_WASM_PIXEL_BLOCK_SEED, WasmSimdPixelBlock } from "./pixel_block_kernel.ts";
import { PixelChunkActivity } from "./pixel_chunk_activity.ts";
import { materialIsMovable } from "./pixel_material.ts";

export interface PixelBlockActiveKernelStepResult {
  readonly moves: number;
  readonly activeChunks: number;
}

/** Schedules half-open active chunk ranges over one resident row-major Wasm SIMD world. */
export class WasmActiveSimdPixelBlock {
  readonly activity: PixelChunkActivity;
  readonly #kernel: WasmSimdPixelBlock;
  readonly #seed: number;

  private constructor(
    kernel: WasmSimdPixelBlock,
    activity: PixelChunkActivity,
    seed: number,
  ) {
    this.#kernel = kernel;
    this.activity = activity;
    this.#seed = seed;
  }

  static async create(
    cells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_WASM_PIXEL_BLOCK_SEED,
    chunkSize = 32,
    minimumMemoryBytes?: number,
  ): Promise<WasmActiveSimdPixelBlock> {
    const kernel = await WasmSimdPixelBlock.create(width, height, minimumMemoryBytes);
    kernel.set(cells);
    const activity = new PixelChunkActivity(width, height, chunkSize);
    for (let index = 0; index < cells.length; index++) {
      const material = cells[index]! & 0xff;
      if (materialIsMovable(material)) {
        activity.activateCell(index % width, Math.floor(index / width));
      }
    }
    return new WasmActiveSimdPixelBlock(kernel, activity, seed);
  }

  step(tick: number): PixelBlockActiveKernelStepResult {
    const activeChunks = this.activity.activeChunkCount;
    let moves = 0;
    this.activity.beginStep();
    this.activity.forEachActiveChunk((bounds) => {
      const result = this.#kernel.stepRange(
        tick,
        bounds.left,
        bounds.top,
        bounds.right,
        bounds.bottom,
        this.#seed,
      );
      moves += result.moves;
      if (result.hot) this.activity.markChunkHot(bounds.index);
    });
    this.activity.finishStep();
    return { moves, activeChunks };
  }

  activateRect(left: number, top: number, right: number, bottom: number): void {
    this.activity.activateRect(left, top, right, bottom);
  }

  get cells(): Uint32Array {
    return this.#kernel.cells;
  }

  get memory(): WebAssembly.Memory {
    return this.#kernel.memory;
  }

  get activeChunkCount(): number {
    return this.activity.activeChunkCount;
  }

  get chunkCount(): number {
    return this.activity.chunkCount;
  }

  get residentBytes(): number {
    return this.#kernel.memory.buffer.byteLength + this.activity.chunkCount * 3;
  }
}
