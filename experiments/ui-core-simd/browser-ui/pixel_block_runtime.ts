import { DEFAULT_PIXEL_BLOCK_SEED, stepPixelWorldBlock } from "../pixel_block_sim.ts";

export class BlockPixelSimulation {
  readonly #cells: Uint32Array;
  readonly #width: number;
  readonly #height: number;
  readonly #seed: number;

  private constructor(
    cells: Uint32Array,
    width: number,
    height: number,
    seed: number,
  ) {
    this.#cells = cells;
    this.#width = width;
    this.#height = height;
    this.#seed = seed;
  }

  static create(
    cells: Uint32Array,
    width: number,
    height: number,
    seed = DEFAULT_PIXEL_BLOCK_SEED,
  ): BlockPixelSimulation {
    return new BlockPixelSimulation(cells, width, height, seed);
  }

  step(tick: number): number {
    return stepPixelWorldBlock(
      this.#cells,
      this.#width,
      this.#height,
      tick,
      this.#seed,
    ).moves;
  }
}
