import { PIXEL_EVENT_KIND } from "./pixel_event_tape.ts";
import { stepPixelReactions } from "./pixel_reaction.ts";
import {
  MATERIAL,
  packPixel,
  pixelFlags,
  pixelMaterial,
  pixelTemperature,
  pixelVariant,
} from "./pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown, label = "value"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("temperature diffusion lets a fire source vaporize adjacent water", () => {
  const ambient = packPixel(MATERIAL.empty, 128);
  const cells = new Uint32Array(9).fill(ambient);
  cells[4] = packPixel(MATERIAL.fire, 255, 7, 9);
  cells[5] = packPixel(MATERIAL.water, 128, 3, 11);
  const scratch = new Uint32Array(cells.length);
  const events: number[][] = [];

  const result = stepPixelReactions(cells, scratch, 3, 3, (kind, index, before, after) => {
    events.push([kind, index, before, after]);
  });

  assertEquals(result, { reactions: 1 });
  assertEquals(pixelMaterial(cells[5]!), MATERIAL.gas, "vaporized material");
  assertEquals(pixelTemperature(cells[5]!), 143, "diffused temperature");
  assertEquals(pixelFlags(cells[5]!), 3, "flags");
  assertEquals(pixelVariant(cells[5]!), 11, "variant");
  assertEquals(events.length, 1, "event count");
  assertEquals(events[0]![0], PIXEL_EVENT_KIND.vaporized, "event kind");
  assertEquals(events[0]![1], 5, "event index");
});

Deno.test("cold gas condenses and diffusion reads the previous generation", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.gas, 64),
    packPixel(MATERIAL.empty, 128),
    packPixel(MATERIAL.gas, 64),
  ]);
  const scratch = new Uint32Array(cells.length);
  const kinds: number[] = [];
  const result = stepPixelReactions(cells, scratch, 3, 1, (kind) => kinds.push(kind));

  assertEquals(result.reactions, 2);
  assertEquals(pixelTemperature(cells[0]!), 72);
  assertEquals(pixelTemperature(cells[2]!), 72);
  assertEquals(pixelMaterial(cells[0]!), MATERIAL.water);
  assertEquals(pixelMaterial(cells[2]!), MATERIAL.water);
  assertEquals(kinds, [PIXEL_EVENT_KIND.condensed, PIXEL_EVENT_KIND.condensed]);
});
