import { stepPixelWorldBlockActive } from "../pixel_block_active_sim.ts";
import { DEFAULT_PIXEL_BLOCK_SEED } from "../pixel_block_sim.ts";
import { PixelChunkActivity } from "../pixel_chunk_activity.ts";
import { materialIsMovable } from "../pixel_material.ts";

export class BlockActivePixelSimulation {
  readonly activity: PixelChunkActivity;
  readonly #cells: Uint32Array;
  readonly #width: number;
  readonly #height: number;
  readonly #seed: number;

  private constructor(
    cells: Uint32Array,
    width: number,
    height: number,
    activity: PixelChunkActivity,
    seed: number,
  ) {
    this.#cells = cells;
    this.#width = width;
    this.#height = height;
    this.activity = activity;
    this.#seed = seed;
  }

  static create(
    cells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_PIXEL_BLOCK_SEED,
  ): BlockActivePixelSimulation {
    const activity = new PixelChunkActivity(width, height);
    for (let index = 0; index < cells.length; index++) {
      const material = cells[index]! & 0xff;
      if (materialIsMovable(material)) {
        activity.activateCell(index % width, Math.floor(index / width));
      }
    }
    return new BlockActivePixelSimulation(cells, width, height, activity, seed);
  }

  step(tick: number): number {
    return stepPixelWorldBlockActive(
      this.#cells,
      this.#width,
      this.#height,
      tick,
      this.activity,
      this.#seed,
    ).activeChunks;
  }

  activateRect(left: number, top: number, right: number, bottom: number): void {
    this.activity.activateRect(left, top, right, bottom);
  }

  get activeChunkCount(): number {
    return this.activity.activeChunkCount;
  }

  get chunkCount(): number {
    return this.activity.chunkCount;
  }

  get residentBytes(): number {
    return this.activity.chunkCount * 3;
  }
}
