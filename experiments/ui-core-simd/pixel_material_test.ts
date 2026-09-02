import {
  ALL_PIXEL_MATERIALS,
  MATERIAL,
  materialDensity,
  materialIsCombustible,
  materialIsFluid,
  materialIsHeatSource,
  materialIsMovable,
  materialIsSolid,
} from "./pixel_material.ts";

function assertEquals(actual: unknown, expected: unknown, label = "value"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("pixel material ids stay dense and fit one SIMD lookup table", () => {
  assertEquals(ALL_PIXEL_MATERIALS, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assertEquals(Object.values(MATERIAL), ALL_PIXEL_MATERIALS);
});

Deno.test("pixel material properties cover common falling-sand categories", () => {
  assertEquals(
    ALL_PIXEL_MATERIALS.map(materialDensity),
    [0, 0, 4, 2, -1, 0, 0, 0, 1, -2, 2, 3],
    "density table",
  );
  assertEquals(
    ALL_PIXEL_MATERIALS.filter(materialIsFluid),
    [MATERIAL.water, MATERIAL.gas, MATERIAL.oil, MATERIAL.smoke, MATERIAL.acid, MATERIAL.lava],
    "fluids",
  );
  assertEquals(
    ALL_PIXEL_MATERIALS.filter(materialIsMovable),
    [
      MATERIAL.sand,
      MATERIAL.water,
      MATERIAL.gas,
      MATERIAL.oil,
      MATERIAL.smoke,
      MATERIAL.acid,
      MATERIAL.lava,
    ],
    "movable",
  );
  assertEquals(
    ALL_PIXEL_MATERIALS.filter(materialIsSolid),
    [MATERIAL.wall, MATERIAL.sand, MATERIAL.fire, MATERIAL.stone, MATERIAL.wood],
    "solids",
  );
  assertEquals(
    ALL_PIXEL_MATERIALS.filter(materialIsCombustible),
    [MATERIAL.wood, MATERIAL.oil],
    "combustible",
  );
  assertEquals(
    ALL_PIXEL_MATERIALS.filter(materialIsHeatSource),
    [MATERIAL.fire, MATERIAL.lava],
    "heat sources",
  );
});
