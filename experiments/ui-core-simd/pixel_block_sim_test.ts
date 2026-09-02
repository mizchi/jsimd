import { createPixelBlockPlan, stepPixelWorldBlock } from "./pixel_block_sim.ts";
import { countPixelMaterials, MATERIAL, packPixel, pixelMaterial } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("pixel block plans alternate non-overlapping 2x2 partitions", () => {
  assertEquals(createPixelBlockPlan(6, 4, 0), {
    origin: 0,
    blockColumns: 3,
    blockRows: 2,
    blockCount: 6,
  });
  assertEquals(createPixelBlockPlan(6, 4, 1), {
    origin: 1,
    blockColumns: 2,
    blockRows: 1,
    blockCount: 2,
  });
  assertEquals(createPixelBlockPlan(5, 5, 0).blockCount, 4);
  assertEquals(createPixelBlockPlan(5, 5, 1).blockCount, 4);
});

Deno.test("pixel block movement conserves complete cells for every local material state", () => {
  const materials = [
    MATERIAL.empty,
    MATERIAL.wall,
    MATERIAL.sand,
    MATERIAL.water,
    MATERIAL.gas,
  ] as const;
  let states = 0;
  for (const topLeft of materials) {
    for (const topRight of materials) {
      for (const bottomLeft of materials) {
        for (const bottomRight of materials) {
          const cells = new Uint32Array([
            packPixel(topLeft, 11, 1, 21),
            packPixel(topRight, 12, 2, 22),
            packPixel(bottomLeft, 13, 3, 23),
            packPixel(bottomRight, 14, 4, 24),
          ]);
          const before = Array.from(cells).toSorted((left, right) => left - right);

          const result = stepPixelWorldBlock(cells, 2, 2, 0, states);

          assertEquals(Array.from(cells).toSorted((left, right) => left - right), before);
          assertEquals(result.blocks, 1);
          states++;
        }
      }
    }
  }
  assertEquals(states, 625);
});

Deno.test("pixel block gravity sinks dense cells and raises gas", () => {
  const falling = new Uint32Array([
    packPixel(MATERIAL.sand),
    packPixel(MATERIAL.wall),
    packPixel(MATERIAL.water),
    packPixel(MATERIAL.wall),
  ]);
  const rising = new Uint32Array([
    packPixel(MATERIAL.empty),
    packPixel(MATERIAL.wall),
    packPixel(MATERIAL.gas),
    packPixel(MATERIAL.wall),
  ]);

  stepPixelWorldBlock(falling, 2, 2, 0, 1);
  stepPixelWorldBlock(rising, 2, 2, 0, 1);

  assertEquals(Array.from(falling, pixelMaterial), [
    MATERIAL.water,
    MATERIAL.wall,
    MATERIAL.sand,
    MATERIAL.wall,
  ]);
  assertEquals(Array.from(rising, pixelMaterial), [
    MATERIAL.gas,
    MATERIAL.wall,
    MATERIAL.empty,
    MATERIAL.wall,
  ]);
});

Deno.test("pixel block cells move at most once per tick", () => {
  const fallingWater = new Uint32Array([
    packPixel(MATERIAL.water),
    packPixel(MATERIAL.empty),
    packPixel(MATERIAL.empty),
    packPixel(MATERIAL.empty),
  ]);
  const risingGas = new Uint32Array([
    packPixel(MATERIAL.empty),
    packPixel(MATERIAL.empty),
    packPixel(MATERIAL.gas),
    packPixel(MATERIAL.empty),
  ]);

  stepPixelWorldBlock(fallingWater, 2, 2, 0, 0);
  stepPixelWorldBlock(risingGas, 2, 2, 0, 0);

  assertEquals(Array.from(fallingWater, pixelMaterial), [
    MATERIAL.empty,
    MATERIAL.empty,
    MATERIAL.water,
    MATERIAL.empty,
  ]);
  assertEquals(Array.from(risingGas, pixelMaterial), [
    MATERIAL.gas,
    MATERIAL.empty,
    MATERIAL.empty,
    MATERIAL.empty,
  ]);
});

Deno.test("pixel block toppling can move sand diagonally around a wall", () => {
  let toppled = false;
  for (let seed = 0; seed < 64; seed++) {
    const cells = new Uint32Array([
      packPixel(MATERIAL.sand),
      packPixel(MATERIAL.empty),
      packPixel(MATERIAL.wall),
      packPixel(MATERIAL.empty),
    ]);
    stepPixelWorldBlock(cells, 2, 2, 0, seed);
    if (pixelMaterial(cells[3]!) === MATERIAL.sand) toppled = true;
  }
  assert(toppled, "at least one deterministic seed must permit diagonal toppling");
});

Deno.test("pixel block lateral liquid movement is seeded instead of directionally fixed", () => {
  const outcomes = new Set<string>();
  for (let seed = 0; seed < 64; seed++) {
    const cells = new Uint32Array([
      packPixel(MATERIAL.water),
      packPixel(MATERIAL.empty),
      packPixel(MATERIAL.wall),
      packPixel(MATERIAL.wall),
    ]);
    stepPixelWorldBlock(cells, 2, 2, 0, seed);
    outcomes.add(Array.from(cells, pixelMaterial).join(","));
  }
  assertEquals(outcomes.size, 2);
});

Deno.test("pixel block replay is deterministic and conserves a closed mixed world", () => {
  const width = 9;
  const height = 9;
  const initial = new Uint32Array(width * height);
  for (let x = 0; x < width; x++) {
    initial[x] = packPixel(MATERIAL.wall);
    initial[(height - 1) * width + x] = packPixel(MATERIAL.wall);
  }
  for (let y = 1; y < height - 1; y++) {
    initial[y * width] = packPixel(MATERIAL.wall);
    initial[y * width + width - 1] = packPixel(MATERIAL.wall);
  }
  initial[2 * width + 2] = packPixel(MATERIAL.sand, 150, 3, 7);
  initial[2 * width + 4] = packPixel(MATERIAL.water, 80, 4, 8);
  initial[6 * width + 5] = packPixel(MATERIAL.gas, 190, 5, 9);
  const expectedCounts = countPixelMaterials(initial);
  const left = initial.slice();
  const right = initial.slice();

  for (let tick = 0; tick < 100; tick++) {
    stepPixelWorldBlock(left, width, height, tick, 0x51f1_5e5d);
    stepPixelWorldBlock(right, width, height, tick, 0x51f1_5e5d);
  }

  assertEquals(Array.from(left), Array.from(right));
  assertEquals(countPixelMaterials(left), expectedCounts);
});

Deno.test("pixel block stepping validates dimensions, shape, tick, and seed", () => {
  let errors = 0;
  for (
    const invoke of [
      () => createPixelBlockPlan(0, 2, 0),
      () => stepPixelWorldBlock(new Uint32Array(3), 2, 2, 0, 0),
      () => stepPixelWorldBlock(new Uint32Array(4), 2, 2, -1, 0),
      () => stepPixelWorldBlock(new Uint32Array(4), 2, 2, 0, -1),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 4);
});
