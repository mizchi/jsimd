import { PIXEL_EVENT_KIND } from "./pixel_event_tape.ts";
import { stepPixelReactions } from "./pixel_reaction.ts";
import {
  createPixelMaterialShowcase,
  MATERIAL,
  packPixel,
  pixelFlags,
  pixelMaterial,
  pixelTemperature,
  pixelVariant,
  seedPixelMaterialShowcaseInteractions,
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

  assertEquals(result, { reactions: 2 });
  assertEquals(pixelMaterial(cells[4]!), MATERIAL.smoke, "extinguished material");
  assertEquals(pixelMaterial(cells[5]!), MATERIAL.gas, "vaporized material");
  assertEquals(pixelTemperature(cells[5]!), 143, "diffused temperature");
  assertEquals(pixelFlags(cells[5]!), 3, "flags");
  assertEquals(pixelVariant(cells[5]!), 11, "variant");
  assertEquals(events.length, 2, "event count");
  assertEquals(events[0]![0], PIXEL_EVENT_KIND.extinguished, "fire event kind");
  assertEquals(events[0]![1], 4, "fire event index");
  assertEquals(events[1]![0], PIXEL_EVENT_KIND.vaporized, "water event kind");
  assertEquals(events[1]![1], 5, "water event index");
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

Deno.test("lava is a heat source and hot wood and oil ignite", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.lava, 128),
    packPixel(MATERIAL.wood, 192, 3, 7),
    packPixel(MATERIAL.oil, 192, 4, 9),
  ]);
  const scratch = new Uint32Array(cells.length);
  const kinds: number[] = [];

  const result = stepPixelReactions(cells, scratch, 3, 1, (kind) => kinds.push(kind));

  assertEquals(result.reactions, 2);
  assertEquals(pixelTemperature(cells[0]!), 255, "lava temperature");
  assertEquals(pixelMaterial(cells[1]!), MATERIAL.fire, "wood ignition");
  assertEquals(pixelMaterial(cells[2]!), MATERIAL.fire, "oil ignition");
  assertEquals(pixelFlags(cells[1]!), 3, "wood flags");
  assertEquals(pixelVariant(cells[2]!), 9, "oil variant");
  assertEquals(kinds, [PIXEL_EVENT_KIND.ignited, PIXEL_EVENT_KIND.ignited]);
});

Deno.test("neighbor chemistry solidifies lava and water symmetrically", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.lava, 255, 1, 2),
    packPixel(MATERIAL.water, 128, 3, 4),
  ]);
  const scratch = new Uint32Array(cells.length);
  const events: number[][] = [];

  const result = stepPixelReactions(cells, scratch, 2, 1, (kind, index) => {
    events.push([kind, index]);
  });

  assertEquals(result.reactions, 2);
  assertEquals(Array.from(cells, pixelMaterial), [MATERIAL.stone, MATERIAL.stone]);
  assertEquals(events, [
    [PIXEL_EVENT_KIND.solidified, 0],
    [PIXEL_EVENT_KIND.solidified, 1],
  ]);
  assertEquals(pixelFlags(cells[0]!), 1, "lava flags");
  assertEquals(pixelVariant(cells[1]!), 4, "water variant");
});

Deno.test("acid corrodes adjacent stone and wood", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.stone),
    packPixel(MATERIAL.acid),
    packPixel(MATERIAL.wood),
  ]);
  const scratch = new Uint32Array(cells.length);
  const events: number[][] = [];

  const result = stepPixelReactions(cells, scratch, 3, 1, (kind, index) => {
    events.push([kind, index]);
  });

  assertEquals(result.reactions, 2);
  assertEquals(Array.from(cells, pixelMaterial), [MATERIAL.empty, MATERIAL.acid, MATERIAL.empty]);
  assertEquals(events, [
    [PIXEL_EVENT_KIND.corroded, 0],
    [PIXEL_EVENT_KIND.corroded, 2],
  ]);
});

Deno.test("neighbor heat ignites combustibles unless acid wins precedence", () => {
  const heated = new Uint32Array([
    packPixel(MATERIAL.wood, 128),
    packPixel(MATERIAL.fire, 255),
    packPixel(MATERIAL.oil, 128),
  ]);
  const competing = new Uint32Array([
    packPixel(MATERIAL.acid, 128),
    packPixel(MATERIAL.wood, 128),
    packPixel(MATERIAL.fire, 255),
  ]);
  const scratch = new Uint32Array(3);

  stepPixelReactions(heated, scratch, 3, 1);
  stepPixelReactions(competing, scratch, 3, 1);

  assertEquals(Array.from(heated, pixelMaterial), [MATERIAL.fire, MATERIAL.fire, MATERIAL.fire]);
  assertEquals(Array.from(competing, pixelMaterial), [
    MATERIAL.acid,
    MATERIAL.empty,
    MATERIAL.fire,
  ]);
});

Deno.test("water extinguishes fire into smoke while the water vaporizes", () => {
  const cells = new Uint32Array([
    packPixel(MATERIAL.fire, 255, 2, 3),
    packPixel(MATERIAL.water, 128, 4, 5),
  ]);
  const scratch = new Uint32Array(cells.length);
  const events: number[][] = [];

  const result = stepPixelReactions(cells, scratch, 2, 1, (kind, index) => {
    events.push([kind, index]);
  });

  assertEquals(result.reactions, 2);
  assertEquals(Array.from(cells, pixelMaterial), [MATERIAL.smoke, MATERIAL.gas]);
  assertEquals(events, [
    [PIXEL_EVENT_KIND.extinguished, 0],
    [PIXEL_EVENT_KIND.vaporized, 1],
  ]);
  assertEquals(pixelFlags(cells[0]!), 2, "fire flags");
  assertEquals(pixelVariant(cells[0]!), 3, "fire variant");
});

Deno.test("material showcase exposes and can replenish every compound reaction", () => {
  const width = 128;
  const height = 80;
  const cells = createPixelMaterialShowcase(width, height, 0.25, 123, "full");
  const scratch = new Uint32Array(cells.length);
  const kinds = new Set<number>();

  for (let pass = 0; pass < 2; pass++) {
    stepPixelReactions(cells, scratch, width, height, (kind) => kinds.add(kind));
    for (
      const kind of [
        PIXEL_EVENT_KIND.extinguished,
        PIXEL_EVENT_KIND.solidified,
        PIXEL_EVENT_KIND.corroded,
        PIXEL_EVENT_KIND.ignited,
      ]
    ) {
      assertEquals(kinds.has(kind), true, `pass ${pass} reaction kind ${kind}`);
    }
    kinds.clear();
    seedPixelMaterialShowcaseInteractions(cells, width, height, "full");
  }
});
