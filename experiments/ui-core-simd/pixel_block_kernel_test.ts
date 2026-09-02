import { DEFAULT_WASM_PIXEL_BLOCK_SEED, WasmSimdPixelBlock } from "./pixel_block_kernel.ts";
import {
  DEFAULT_PIXEL_BLOCK_SEED,
  stepPixelBlockRangeUnchecked,
  stepPixelWorldBlock,
} from "./pixel_block_sim.ts";
import { countPixelMaterials, MATERIAL, packPixel } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown, message = "values differ"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("Wasm SIMD block backend shares the scalar default seed contract", () => {
  assertEquals(DEFAULT_WASM_PIXEL_BLOCK_SEED, DEFAULT_PIXEL_BLOCK_SEED);
});

Deno.test("Wasm SIMD block backend matches scalar row-major evolution", async () => {
  const width = 34;
  const height = 27;
  const initial = createMixedWorld(width, height, 0x1234_5678);
  const scalar = initial.slice();
  const simd = await WasmSimdPixelBlock.create(width, height);
  simd.set(initial);
  const counts = countPixelMaterials(initial);

  for (let tick = 0; tick < 160; tick++) {
    const expected = stepPixelWorldBlock(scalar, width, height, tick, 0x51f1_5e5d);
    const moves = simd.step(tick, 0x51f1_5e5d);
    assertEquals(moves, expected.moves, `move count at tick ${tick}`);
    assertCellsEqual(simd.cells, scalar, `cells at tick ${tick}`);
  }
  assertEquals(countPixelMaterials(simd.cells), counts, "material counts");
});

Deno.test("Wasm SIMD block backend preserves complete metadata cells", async () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.sand, 11, 1, 21),
    packPixel(MATERIAL.water, 12, 2, 22),
    packPixel(MATERIAL.gas, 13, 3, 23),
    packPixel(MATERIAL.empty, 14, 4, 24),
    packPixel(MATERIAL.water, 15, 5, 25),
    packPixel(MATERIAL.sand, 16, 6, 26),
    packPixel(MATERIAL.empty, 17, 7, 27),
    packPixel(MATERIAL.gas, 18, 8, 28),
  ]);
  const before = Array.from(cells).toSorted((left, right) => left - right);
  const simd = await WasmSimdPixelBlock.create(4, 2);
  simd.set(cells);

  simd.step(0, 7);

  assertEquals(Array.from(simd.cells).toSorted((left, right) => left - right), before);
});

Deno.test("Wasm SIMD range owns the same half-open blocks and reports hot material", async () => {
  const width = 35;
  const height = 29;
  const initial = createMixedWorld(width, height, 0x9876_5432);
  const expected = initial.slice();
  let hot = false;
  const expectedResult = stepPixelBlockRangeUnchecked(
    expected,
    width,
    height,
    1,
    DEFAULT_PIXEL_BLOCK_SEED,
    7,
    5,
    27,
    23,
    () => hot = true,
  );
  const simd = await WasmSimdPixelBlock.create(width, height);
  simd.set(initial);

  const result = simd.stepRange(1, 7, 5, 27, 23);

  assertEquals(result, { moves: expectedResult.moves, hot });
  assertCellsEqual(simd.cells, expected, "range cells");
});

Deno.test("Wasm SIMD block backend validates dimensions, input, tick, and seed", async () => {
  await assertRejects(() => WasmSimdPixelBlock.create(0, 4), RangeError);
  const simd = await WasmSimdPixelBlock.create(4, 4);
  assertThrows(() => simd.set(new Uint32Array(15)), RangeError);
  assertThrows(() => simd.step(-1), RangeError);
  assertThrows(() => simd.step(0, -1), RangeError);
  assertThrows(() => simd.stepRange(0, 0, 0, 5, 4), RangeError);
});

function createMixedWorld(width: number, height: number, initialSeed: number): Uint32Array {
  const cells = new Uint32Array(width * height);
  let seed = initialSeed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        cells[index] = packPixel(MATERIAL.wall);
        continue;
      }
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const roll = (seed >>> 0) % 20;
      const material = roll < 2
        ? MATERIAL.wall
        : roll < 8
        ? MATERIAL.sand
        : roll < 13
        ? MATERIAL.water
        : roll < 15
        ? MATERIAL.gas
        : MATERIAL.empty;
      cells[index] = packPixel(material, roll * 7, x, y);
    }
  }
  return cells;
}

function assertCellsEqual(actual: Uint32Array, expected: Uint32Array, message: string): void {
  if (actual.length !== expected.length) throw new Error(`${message}: length mismatch`);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${message}: cell ${index}, expected ${expected[index]}, got ${actual[index]}`,
      );
    }
  }
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
