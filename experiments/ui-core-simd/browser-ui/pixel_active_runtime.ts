import { PixelChunkActivity } from "../pixel_chunk_activity.ts";
import { stepPixelWorldActive } from "../pixel_active_sim.ts";

export class ActivePixelSimulation {
  readonly activity: PixelChunkActivity;
  readonly #cells: Uint32Array;
  readonly #width: number;
  readonly #height: number;

  private constructor(
    cells: Uint32Array,
    width: number,
    height: number,
    activity: PixelChunkActivity,
  ) {
    this.#cells = cells;
    this.#width = width;
    this.#height = height;
    this.activity = activity;
  }

  static create(cells: Uint32Array, width: number, height: number): ActivePixelSimulation {
    const activity = new PixelChunkActivity(width, height);
    for (let index = 0; index < cells.length; index++) {
      const material = cells[index]! & 0xff;
      if (material === 2 || material === 3) {
        activity.activateCell(index % width, Math.floor(index / width));
      }
    }
    return new ActivePixelSimulation(cells, width, height, activity);
  }

  step(phase: number): number {
    return stepPixelWorldActive(
      this.#cells,
      this.#width,
      this.#height,
      phase,
      this.activity,
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
