import { PixelChunkActivity } from "./pixel_chunk_activity.ts";
import { stepPixelWorldActive } from "./pixel_active_sim.ts";
import { MATERIAL, packPixel, paintPixelCircle, stepPixelWorld } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("chunk activity expands around writes and cools after two idle phases", () => {
  const activity = new PixelChunkActivity(96, 64, 32);
  activity.activateCell(40, 16);

  assertEquals(activity.chunkCount, 6);
  assertEquals(activity.activeChunkCount, 6);
  activity.beginStep();
  activity.finishStep();
  assertEquals(activity.activeChunkCount, 6);
  activity.beginStep();
  activity.finishStep();
  assertEquals(activity.activeChunkCount, 0);
});

Deno.test("active chunks match full scan for a localized falling-sand world", () => {
  const width = 96;
  const height = 96;
  const full = new Uint32Array(width * height);
  full.fill(packPixel(MATERIAL.empty));
  for (let x = 0; x < width; x++) full[(height - 1) * width + x] = packPixel(MATERIAL.wall);
  paintPixelCircle(full, width, height, 46, 10, 8, MATERIAL.sand);
  const sparse = full.slice();
  const activity = new PixelChunkActivity(width, height, 32);
  activity.activateCell(46, 10);

  for (let tick = 0; tick < 120; tick++) {
    stepPixelWorld(full, width, height, tick);
    stepPixelWorldActive(sparse, width, height, tick, activity);
  }

  assertEquals(Array.from(sparse), Array.from(full));
  assertEquals(activity.activeChunkCount < activity.chunkCount, true);
});

Deno.test("a brush can wake a sleeping chunk neighborhood", () => {
  const activity = new PixelChunkActivity(256, 256, 32);
  activity.activateCell(10, 10);
  activity.beginStep();
  activity.finishStep();
  activity.beginStep();
  activity.finishStep();
  assertEquals(activity.activeChunkCount, 0);

  activity.activateRect(200, 200, 220, 220);
  assertEquals(activity.activeChunkCount > 0, true);
});

Deno.test("a kernel can retain one hot owner chunk without publishing cell coordinates", () => {
  const activity = new PixelChunkActivity(96, 64, 32);

  activity.beginStep();
  activity.markChunkHot(0);
  activity.finishStep();

  assertEquals(activity.activeChunkCount, 4);
});
