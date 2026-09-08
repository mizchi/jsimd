import { createPixelGearKernel } from "./kernel.ts";
import { MATERIAL, packPixel, stepPixelWorld } from "../ui-core-simd/pixel_sim.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const wasmBytes = await Deno.readFile(
  new URL("./zig/kernel.wasm", import.meta.url),
);

Deno.test("Zig Wasm ABI imports only host memory and exports only leaf kernels", () => {
  const module = new WebAssembly.Module(wasmBytes);
  const imports = WebAssembly.Module.imports(module).map((entry) =>
    `${entry.module}.${entry.name}:${entry.kind}`
  );
  const exports = WebAssembly.Module.exports(module).map((entry) => `${entry.name}:${entry.kind}`)
    .toSorted();

  assertEquals(imports, ["env.memory:memory"]);
  assertEquals(exports, [
    "advance_gear:function",
    "classify_gel_fracture:function",
    "gear_contains:function",
    "scan_gel_boundary:function",
    "step_pixel_world:function",
  ]);
});

Deno.test("Zig Wasm kernel exposes gear geometry through host-owned memory", async () => {
  const kernel = await createPixelGearKernel({ wasmBytes });
  const gear = {
    centerX: 20,
    centerY: 17,
    radius: 7,
    toothDepth: 3,
    teeth: 10,
    angle: 0,
    angularVelocity: 0.16,
  };

  assertEquals(kernel.containsGearCell(gear, 20, 17), true);
  assertEquals(kernel.containsGearCell(gear, 0, 0), false);
});

Deno.test("Zig Wasm kernel scans SoA boundary coordinates", async () => {
  const kernel = await createPixelGearKernel({ wasmBytes });
  const result = kernel.scanGelBoundary(
    new Float32Array([-2, -1, 1, 2]),
    new Float32Array([1, -3, 4, 0]),
    { centerX: 10, centerY: 20, cosine: 1, sine: 0 },
    null,
  );

  assertEquals(result.checks, 4);
  assertEquals(result.contacts, 0);
  assertEquals(result.minimumX, 8);
  assertEquals(result.maximumX, 12);
  assertEquals(result.maximumY, 24);
});

Deno.test("Zig Wasm kernel classifies all fracture cells into a byte mask", async () => {
  const kernel = await createPixelGearKernel({ wasmBytes });
  const result = kernel.classifyGelFracture(
    new Float32Array([-100, 0, -50, 0, 50, 0, 100, 0, 120, 0]),
    {
      normalX: 1,
      normalY: 0,
      tangentX: 0,
      tangentY: 1,
      offset: 0,
      clusterId: 1,
    },
  );

  assertEquals(result.negativeCount, 2);
  assertEquals([...result.sides], [1, 1, 0, 0, 0]);
});

Deno.test("Zig SIMD world step matches the TypeScript reference across phases", async () => {
  const kernel = await createPixelGearKernel({ wasmBytes });
  const width = 9;
  const height = 7;
  const source = new Uint32Array(width * height);
  for (let x = 0; x < width; x++) source[(height - 1) * width + x] = packPixel(MATERIAL.wall);
  for (let index = 0; index < source.length - width; index++) {
    if (index % 7 === 1) source[index] = packPixel(MATERIAL.sand, index & 0xff);
    else if (index % 5 === 2) source[index] = packPixel(MATERIAL.water, index & 0xff);
  }
  const expected = source.slice();
  const actual = kernel.createWorld(source);

  for (let phase = 0; phase < 24; phase++) {
    const expectedMoves = stepPixelWorld(expected, width, height, phase).moves;
    const actualMoves = kernel.stepWorld(actual, width, height, phase);
    assertEquals(actualMoves, expectedMoves);
    assertEquals([...actual], [...expected]);
  }
});
