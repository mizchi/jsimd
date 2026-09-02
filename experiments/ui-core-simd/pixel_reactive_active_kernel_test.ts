import { PIXEL_EVENT_KIND, PIXEL_EVENT_RECORD_WORDS, PixelEventTape } from "./pixel_event_tape.ts";
import { WasmReactiveActiveSimdPixelBlock } from "./pixel_reactive_active_kernel.ts";
import { MATERIAL, packPixel, pixelMaterial } from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("reactive active SIMD shares one world and flushes bounded events", async () => {
  const width = 8;
  const height = 5;
  const cells = new Uint32Array(width * height).fill(packPixel(MATERIAL.wall));
  cells[2 * width + 3] = packPixel(MATERIAL.fire, 255);
  cells[2 * width + 4] = packPixel(MATERIAL.water, 128);
  const simulation = await WasmReactiveActiveSimdPixelBlock.create(cells, width, height, 8);
  const tape = PixelEventTape.create(8);
  const output = new Int32Array(8 * PIXEL_EVENT_RECORD_WORDS);

  const result = simulation.step(0);
  simulation.flushEvents(tape);

  assertEquals(result.reactions, 1);
  assertEquals(pixelMaterial(simulation.cells[2 * width + 4]!), MATERIAL.gas);
  assertEquals(tape.drainInto(output), 1);
  assertEquals(output[0], PIXEL_EVENT_KIND.vaporized);
  assertEquals(output[1], 2 * width + 4);
});
