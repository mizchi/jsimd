import { stepPixelWorldBlockActive } from "./pixel_block_active_sim.ts";
import { createPixelBlockPlan, stepPixelWorldBlock } from "./pixel_block_sim.ts";
import { PixelChunkActivity } from "./pixel_chunk_activity.ts";
import { countPixelMaterials, MATERIAL, packPixel, paintPixelCircle } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function activateDynamicCells(
  cells: Uint32Array,
  width: number,
  activity: PixelChunkActivity,
): void {
  for (let index = 0; index < cells.length; index++) {
    const material = cells[index]! & 0xff;
    if (material === MATERIAL.sand || material === MATERIAL.water || material === MATERIAL.gas) {
      activity.activateCell(index % width, Math.floor(index / width));
    }
  }
}

Deno.test("active block stepping exactly matches a full scan across chunk boundaries", () => {
  const width = 130;
  const height = 98;
  const initial = new Uint32Array(width * height);
  for (let x = 0; x < width; x++) {
    initial[x] = packPixel(MATERIAL.wall);
    initial[(height - 1) * width + x] = packPixel(MATERIAL.wall);
  }
  for (let y = 1; y < height - 1; y++) {
    initial[y * width] = packPixel(MATERIAL.wall);
    initial[y * width + width - 1] = packPixel(MATERIAL.wall);
  }
  paintPixelCircle(initial, width, height, 63, 17, 9, MATERIAL.sand);
  paintPixelCircle(initial, width, height, 68, 35, 11, MATERIAL.water);
  paintPixelCircle(initial, width, height, 32, 79, 7, MATERIAL.gas);
  const full = initial.slice();
  const sparse = initial.slice();
  const activity = new PixelChunkActivity(width, height, 32);
  activateDynamicCells(sparse, width, activity);
  const counts = countPixelMaterials(initial);

  for (let tick = 0; tick < 180; tick++) {
    stepPixelWorldBlock(full, width, height, tick, 0x1234_5678);
    stepPixelWorldBlockActive(sparse, width, height, tick, activity, 0x1234_5678);
  }

  assertEquals(Array.from(sparse), Array.from(full));
  assertEquals(countPixelMaterials(sparse), counts);
  assert(
    activity.activeChunkCount < activity.chunkCount,
    "localized material should leave some chunks asleep",
  );
});

Deno.test("active block stepping cools an idle world and stops scanning blocks", () => {
  const width = 128;
  const height = 96;
  const cells = new Uint32Array(width * height);
  const activity = new PixelChunkActivity(width, height, 32);
  activity.activateCell(64, 48);

  const first = stepPixelWorldBlockActive(cells, width, height, 0, activity);
  const second = stepPixelWorldBlockActive(cells, width, height, 1, activity);
  const sleeping = stepPixelWorldBlockActive(cells, width, height, 2, activity);

  assert(first.blocks > 0, "hot chunks must initially be scanned");
  assert(second.blocks > 0, "one cooling phase must remain");
  assertEquals(sleeping, { moves: 0, blocks: 0, activeChunks: 0 });
});

Deno.test("active chunk ownership visits every full-world block exactly once", () => {
  const width = 65;
  const height = 67;
  const cells = new Uint32Array(width * height);
  const activity = new PixelChunkActivity(width, height, 32);
  activity.activateRect(0, 0, width - 1, height - 1);

  for (let tick = 0; tick < 2; tick++) {
    const result = stepPixelWorldBlockActive(cells, width, height, tick, activity);
    assertEquals(result.blocks, createPixelBlockPlan(width, height, tick).blockCount);
  }
});

Deno.test("a brush wakes the active block solver after it sleeps", () => {
  const width = 128;
  const height = 96;
  const cells = new Uint32Array(width * height);
  const activity = new PixelChunkActivity(width, height, 32);
  activity.activateCell(10, 10);
  stepPixelWorldBlockActive(cells, width, height, 0, activity);
  stepPixelWorldBlockActive(cells, width, height, 1, activity);
  stepPixelWorldBlockActive(cells, width, height, 2, activity);
  assertEquals(activity.activeChunkCount, 0);

  cells[20 * width + 65] = packPixel(MATERIAL.sand);
  activity.activateRect(65, 20, 65, 20);
  const woken = stepPixelWorldBlockActive(cells, width, height, 3, activity);
  const moved = stepPixelWorldBlockActive(cells, width, height, 4, activity);

  assert(woken.blocks > 0, "the painted chunk neighborhood must be scanned");
  assert(moved.moves > 0, "the painted sand must move on a compatible partition");
});

Deno.test("active block stepping rejects mismatched activity dimensions", () => {
  let threw = false;
  try {
    stepPixelWorldBlockActive(
      new Uint32Array(16),
      4,
      4,
      0,
      new PixelChunkActivity(8, 8),
    );
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "mismatched activity must throw a RangeError");
});
