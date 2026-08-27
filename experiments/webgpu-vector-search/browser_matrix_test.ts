import { assertSameTopK, firstBatchCrossover, makeQueries, makeValues } from "./browser_matrix.ts";

Deno.test("browser WebGPU matrix inputs are deterministic and select resident rows", () => {
  const values = makeValues(8, 3);
  const repeated = makeValues(8, 3);
  assertEquals([...values], [...repeated]);

  const queries = makeQueries(values, 8, 3, 4);
  assertEquals(queries.length, 12);
  assertEquals([...queries.subarray(0, 3)], [...values.subarray(0, 3)]);
  for (let query = 0; query < 4; query++) {
    const sourceRow = Math.imul(query, 9_973) % 8;
    assertEquals(
      [...queries.subarray(query * 3, query * 3 + 3)],
      [...values.subarray(sourceRow * 3, sourceRow * 3 + 3)],
    );
  }
});

Deno.test("browser WebGPU matrix checks complete top-k ordering", () => {
  assertSameTopK(
    new Uint32Array([2, 5]),
    new Float32Array([0.25, 1.5]),
    new Uint32Array([2, 5]),
    new Float32Array([0.25, 1.500_001]),
  );
  assertThrows(() =>
    assertSameTopK(
      new Uint32Array([2, 5]),
      new Float32Array([0.25, 1.5]),
      new Uint32Array([2, 4]),
      new Float32Array([0.25, 1.5]),
    )
  );
});

Deno.test("browser WebGPU matrix finds the first row crossover per batch", () => {
  const measurements = [
    { rows: 1_024, batches: [{ queryCount: 16, wasmMedianMs: 1, webgpuMedianMs: 4 }] },
    { rows: 4_096, batches: [{ queryCount: 16, wasmMedianMs: 5, webgpuMedianMs: 4 }] },
    { rows: 16_384, batches: [{ queryCount: 16, wasmMedianMs: 20, webgpuMedianMs: 8 }] },
  ];
  assertEquals(firstBatchCrossover(measurements, 16), 4_096);
  assertEquals(firstBatchCrossover(measurements, 64), null);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertThrows(operation: () => void): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("expected operation to throw");
}
