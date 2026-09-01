import { estimatePackedGraphMemory } from "./diagnostics.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("packed graph diagnostics estimates dense and typed-array storage", () => {
  assertEquals(estimatePackedGraphMemory(32, 4_096, 16_384), {
    denseMatrixBytes: 16_384,
    wasmMemoryBytes: 65_536,
    typedArrayBytes: 98_432,
    totalBytes: 163_968,
  });
});

Deno.test("packed graph diagnostics estimates selective dense rows", () => {
  assertEquals(estimatePackedGraphMemory(4_128, 4_352, 16_640, 0), {
    denseMatrixBytes: 0,
    wasmMemoryBytes: 65_536,
    typedArrayBytes: 117_888,
    totalBytes: 183_424,
  });
});
