import { stepLife } from "./life_game.ts";
import { WasmSimdLife } from "./life_kernel.ts";

Deno.test("Wasm SIMD Life matches scalar toroidal evolution", async () => {
  const width = 32;
  const height = 19;
  let scalarCurrent: Uint8Array = randomBoard(width * height, 0x1234_5678);
  let scalarNext: Uint8Array = new Uint8Array(scalarCurrent.length);
  const simd = await WasmSimdLife.create(width, height);
  simd.set(scalarCurrent);

  for (let generation = 0; generation < 20; generation++) {
    const scalarLive = stepLife(scalarCurrent, scalarNext, width, height);
    [scalarCurrent, scalarNext] = [scalarNext, scalarCurrent];
    const simdLive = simd.step();
    assertEquals(simdLive, scalarLive, `live count at generation ${generation + 1}`);
    assertBytesEqual(simd.cells, scalarCurrent, `cells at generation ${generation + 1}`);
  }
});

Deno.test("Wasm SIMD Life validates dimensions and input size", async () => {
  await assertRejects(() => WasmSimdLife.create(31, 16), RangeError);
  const simd = await WasmSimdLife.create(16, 4);
  assertThrows(() => simd.set(new Uint8Array(63)), RangeError);
});

function randomBoard(length: number, initialSeed: number): Uint8Array {
  const cells = new Uint8Array(length);
  let seed = initialSeed;
  for (let index = 0; index < length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    cells[index] = (seed >>> 0) % 100 < 31 ? 1 : 0;
  }
  return cells;
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string): void {
  if (actual.length !== expected.length) throw new Error(`${message}: length mismatch`);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${message}: byte ${index}, expected ${expected[index]}, got ${actual[index]}`,
      );
    }
  }
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
