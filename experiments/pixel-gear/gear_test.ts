import { advancePixelGear, isPixelGearCell } from "./gear.ts";
import {
  countPixelMaterials,
  MATERIAL,
  packPixel,
  pixelFlags,
  pixelMaterial,
  pixelTemperature,
  pixelVariant,
} from "../ui-core-simd/pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("a rotating gear displaces particles without consuming them", () => {
  const width = 40;
  const height = 32;
  const cells = new Uint32Array(width * height);
  const gear = {
    centerX: 20,
    centerY: 17,
    radius: 7,
    toothDepth: 3,
    teeth: 10,
    angle: 0,
    angularVelocity: 0.16,
  };
  const nextAngle = gear.angle + gear.angularVelocity;
  let source = -1;
  for (let y = 0; y < height && source < 0; y++) {
    for (let x = 0; x < width; x++) {
      if (
        !isPixelGearCell(gear, x, y, gear.angle) &&
        isPixelGearCell(gear, x, y, nextAngle)
      ) {
        source = y * width + x;
        break;
      }
    }
  }
  if (source < 0) throw new Error("test gear must expose a leading tooth cell");
  cells[source] = packPixel(MATERIAL.sand, 200, 7, 11);

  const result = advancePixelGear(cells, width, height, gear);

  assertEquals(result.moves, 1);
  assertEquals(result.gear.angle, nextAngle);
  assertEquals(pixelMaterial(cells[source]!), MATERIAL.empty);
  assertEquals(countPixelMaterials(cells)[MATERIAL.sand], 1);
  const destination = cells.findIndex((cell) => pixelMaterial(cell) === MATERIAL.sand);
  assertEquals(
    isPixelGearCell(result.gear, destination % width, Math.floor(destination / width)),
    false,
  );
  assertEquals(pixelTemperature(cells[destination]!), 200);
  assertEquals(pixelFlags(cells[destination]!), 7);
  assertEquals(pixelVariant(cells[destination]!), 11);
});

Deno.test("a rotating gear leaves structural walls fixed", () => {
  const width = 24;
  const height = 24;
  const cells = new Uint32Array(width * height);
  const gear = {
    centerX: 12,
    centerY: 12,
    radius: 5,
    toothDepth: 2,
    teeth: 8,
    angle: 0,
    angularVelocity: 0.2,
  };
  const wall = 12 * width + 12;
  cells[wall] = packPixel(MATERIAL.wall);

  const result = advancePixelGear(cells, width, height, gear);

  assertEquals(result.moves, 0);
  assertEquals(pixelMaterial(cells[wall]!), MATERIAL.wall);
});
