import { SimdMatrix2D } from "../matrix2d/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("SimdMatrix2D preserves shape, indexing, and row padding", () => {
  using matrix = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  assertEquals(matrix.rows, 2, "rows");
  assertEquals(matrix.columns, 3, "columns");
  assertEquals(matrix.get(1, 2), 6, "get");
  matrix.set(0, 1, 20);
  assertEquals(matrix.toFloat32Array().join(","), "1,20,3,4,5,6", "logical copy");
});

Deno.test("SimdMatrix2D multiplies non-SIMD-aligned shapes", () => {
  using left = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix2D.from(3, 2, [7, 8, 9, 10, 11, 12]);
  using output = left.multiply(right);
  assertEquals(output.rows, 2, "output rows");
  assertEquals(output.columns, 2, "output columns");
  assertEquals(output.toFloat32Array().join(","), "58,64,139,154", "matrix product");
});

Deno.test("SimdMatrix2D compound operations ignore padding", () => {
  using left = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix2D.from(2, 3, [10, 20, 30, 40, 50, 60]);
  left.addAssign(right).scaleAssign(0.5);
  assertEquals(left.toFloat32Array().join(","), "5.5,11,16.5,22,27.5,33", "compound");
});

Deno.test("SimdMatrix2D multiplyInto matches scalar multiplication", () => {
  for (const [rows, inner, columns] of [[1, 1, 1], [3, 5, 2], [5, 4, 7]] as const) {
    const leftValues = Float32Array.from(
      { length: rows * inner },
      (_, index) => (index % 11) - 5,
    );
    const rightValues = Float32Array.from(
      { length: inner * columns },
      (_, index) => (index % 7) * 0.25 - 0.5,
    );
    using left = SimdMatrix2D.from(rows, inner, leftValues);
    using right = SimdMatrix2D.from(inner, columns, rightValues);
    using output = new SimdMatrix2D(rows, columns);
    left.multiplyInto(right, output);
    const actual = output.toFloat32Array();
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        let expected = 0;
        for (let index = 0; index < inner; index++) {
          expected += leftValues[row * inner + index]! * rightValues[index * columns + column]!;
        }
        assertClose(
          actual[row * columns + column]!,
          expected,
          Math.max(1e-5, Math.abs(expected) * 1e-5),
          `${rows}x${inner} * ${inner}x${columns} [${row},${column}]`,
        );
      }
    }
  }
});

Deno.test("SimdMatrix2D using lifecycle returns allocator storage", () => {
  const before = SimdMatrix2D.allocatorStats();
  {
    using matrix = new SimdMatrix2D(128, 128);
    matrix.fill(1);
  }
  const after = SimdMatrix2D.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdMatrix2D rejects an aliased multiplication output", () => {
  using matrix = SimdMatrix2D.from(2, 2, [1, 2, 3, 4]);
  let threw = false;
  try {
    matrix.multiplyInto(matrix, matrix);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "aliased output");
});
