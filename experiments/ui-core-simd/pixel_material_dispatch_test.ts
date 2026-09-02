import { WasmPixelMaterialDispatch } from "./pixel_material_dispatch.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("material table and specialized SIMD comparisons classify the same cells", async () => {
  const dispatch = await WasmPixelMaterialDispatch.create(64);
  for (const materialCount of [4, 16, 64, 256]) {
    for (let index = 0; index < dispatch.cells.length; index++) {
      dispatch.cells[index] = (index * 29 % materialCount) | 128 << 8;
    }
    assertEquals(dispatch.tableChecksum(), dispatch.specializedSimdChecksum(materialCount));
  }
});

Deno.test("material dispatch validates SIMD width and material count", async () => {
  const dispatch = await WasmPixelMaterialDispatch.create(64);
  let errors = 0;
  for (
    const invoke of [
      () => WasmPixelMaterialDispatch.create(62),
      () => dispatch.specializedSimdChecksum(0),
      () => dispatch.specializedSimdChecksum(257),
    ]
  ) {
    try {
      await invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 3);
});
