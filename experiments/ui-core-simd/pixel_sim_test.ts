import {
  countPixelMaterials,
  createPixelScenario,
  MATERIAL,
  packPixel,
  paintPixelLine,
  pixelFlags,
  pixelMaterial,
  pixelTemperature,
  pixelVariant,
  stepPixelWorld,
} from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("pixel cells keep the material ABI in the low byte", () => {
  const cell = packPixel(MATERIAL.water, 211, 0xa5, 0x7e);

  assertEquals(pixelMaterial(cell), MATERIAL.water);
  assertEquals(pixelTemperature(cell), 211);
  assertEquals(pixelFlags(cell), 0xa5);
  assertEquals(pixelVariant(cell), 0x7e);
});

Deno.test("pixel scenarios separate occupancy from active-region locality", () => {
  const full = createPixelScenario(128, 80, 0.25, 123, "full");
  const spot = createPixelScenario(128, 80, 0.25, 123, "spot");
  const fullCounts = countPixelMaterials(full);
  const spotCounts = countPixelMaterials(spot);

  assertEquals((spotCounts[MATERIAL.sand] ?? 0) < (fullCounts[MATERIAL.sand] ?? 0), true);
  assertEquals((spotCounts[MATERIAL.water] ?? 0) < (fullCounts[MATERIAL.water] ?? 0), true);
  assertEquals(spot.length, full.length);
});

Deno.test("a vertical material pair sinks sand through water", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.sand),
    packPixel(MATERIAL.water),
  ]);

  const result = stepPixelWorld(cells, 1, 2, 0);

  assertEquals(Array.from(cells, pixelMaterial), [MATERIAL.water, MATERIAL.sand]);
  assertEquals(result.moves, 1);
});

Deno.test("walls are immovable and block falling material", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.sand),
    packPixel(MATERIAL.wall),
  ]);

  const result = stepPixelWorld(cells, 1, 2, 0);

  assertEquals(Array.from(cells, pixelMaterial), [MATERIAL.sand, MATERIAL.wall]);
  assertEquals(result.moves, 0);
});

Deno.test("pixel brush reconstructs a continuous line from coalesced pointer points", () => {
  const cells = new Uint32Array(12 * 5);

  paintPixelLine(cells, 12, 5, 1, 1, 10, 3, 0, MATERIAL.sand);

  for (let x = 1; x <= 10; x++) {
    const y = Math.round(1 + (x - 1) * 2 / 9);
    assertEquals(pixelMaterial(cells[y * 12 + x]!), MATERIAL.sand);
  }
});

Deno.test("pixel stepping is deterministic and conserves every material", () => {
  const width = 8;
  const height = 6;
  const initial = new Uint32Array(width * height);
  for (let x = 0; x < width; x++) initial[(height - 1) * width + x] = packPixel(MATERIAL.wall);
  for (let x = 1; x < 7; x += 2) initial[width + x] = packPixel(MATERIAL.sand);
  for (let x = 0; x < 8; x += 2) initial[2 * width + x] = packPixel(MATERIAL.water);
  const expectedCounts = countPixelMaterials(initial);
  const left = initial.slice();
  const right = initial.slice();

  for (let tick = 0; tick < 20; tick++) {
    stepPixelWorld(left, width, height, tick);
    stepPixelWorld(right, width, height, tick);
  }

  assertEquals(Array.from(left), Array.from(right));
  assertEquals(countPixelMaterials(left), expectedCounts);
});

Deno.test("pixel stepping validates shape and phase", () => {
  let errors = 0;
  for (
    const invoke of [
      () => stepPixelWorld(new Uint32Array(3), 2, 2, 0),
      () => stepPixelWorld(new Uint32Array(4), 2, 2, -1),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 2);
});
