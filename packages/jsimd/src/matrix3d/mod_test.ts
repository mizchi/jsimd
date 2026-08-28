import { SimdMatrix3D } from "../matrix3d/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("SimdMatrix3D preserves batch-major shape and padded indexing", () => {
  using tensor = SimdMatrix3D.from(2, 2, 3, [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
  ]);
  assertEquals(tensor.batches, 2, "batches");
  assertEquals(tensor.rows, 2, "rows");
  assertEquals(tensor.columns, 3, "columns");
  assertEquals(tensor.get(1, 1, 2), 12, "get");
  tensor.set(0, 1, 1, 50);
  assertEquals(
    tensor.toFloat32Array().join(","),
    "1,2,3,4,50,6,7,8,9,10,11,12",
    "batch-major copy",
  );
});

Deno.test("SimdMatrix3D computes an independent product for every batch", () => {
  using left = SimdMatrix3D.from(2, 2, 2, [
    1,
    2,
    3,
    4,
    2,
    0,
    1,
    2,
  ]);
  using right = SimdMatrix3D.from(2, 2, 2, [
    5,
    6,
    7,
    8,
    1,
    3,
    4,
    2,
  ]);
  using output = left.batchMultiply(right);
  assertEquals(output.batches, 2, "output batches");
  assertEquals(output.rows, 2, "output rows");
  assertEquals(output.columns, 2, "output columns");
  assertEquals(
    output.toFloat32Array().join(","),
    "19,22,43,50,2,6,9,7",
    "batched matrix product",
  );
});

Deno.test("SimdMatrix3D batchMultiplyInto matches scalar non-aligned shapes", () => {
  for (
    const [batches, rows, inner, columns] of [
      [1, 1, 1, 1],
      [3, 3, 5, 2],
      [2, 5, 4, 7],
    ] as const
  ) {
    const leftValues = Float32Array.from(
      { length: batches * rows * inner },
      (_, index) => (index % 11) - 5,
    );
    const rightValues = Float32Array.from(
      { length: batches * inner * columns },
      (_, index) => (index % 7) * 0.25 - 0.5,
    );
    using left = SimdMatrix3D.from(batches, rows, inner, leftValues);
    using right = SimdMatrix3D.from(batches, inner, columns, rightValues);
    using output = new SimdMatrix3D(batches, rows, columns);
    left.batchMultiplyInto(right, output);
    const actual = output.toFloat32Array();
    for (let batch = 0; batch < batches; batch++) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          let expected = 0;
          for (let index = 0; index < inner; index++) {
            expected += leftValues[(batch * rows + row) * inner + index]! *
              rightValues[(batch * inner + index) * columns + column]!;
          }
          assertClose(
            actual[(batch * rows + row) * columns + column]!,
            expected,
            Math.max(1e-5, Math.abs(expected) * 1e-5),
            `${batches}x${rows}x${inner} * ${batches}x${inner}x${columns}`,
          );
        }
      }
    }
  }
});

Deno.test("SimdMatrix3D compound operations ignore row padding", () => {
  using left = SimdMatrix3D.from(1, 2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix3D.from(1, 2, 3, [10, 20, 30, 40, 50, 60]);
  left.addAssign(right).scaleAssign(0.5);
  assertEquals(left.toFloat32Array().join(","), "5.5,11,16.5,22,27.5,33", "compound");
});

Deno.test("SimdMatrix3D using lifecycle and multiplication contracts", () => {
  const before = SimdMatrix3D.allocatorStats();
  {
    using left = new SimdMatrix3D(4, 8, 8);
    using right = new SimdMatrix3D(4, 8, 8);
    left.fill(1);
    right.fill(2);
    let aliased = false;
    try {
      left.batchMultiplyInto(right, left);
    } catch (error) {
      aliased = error instanceof RangeError;
    }
    assertEquals(aliased, true, "aliased output");

    using mismatchedBatch = new SimdMatrix3D(1, 8, 8);
    let mismatched = false;
    try {
      left.batchMultiply(mismatchedBatch);
    } catch (error) {
      mismatched = error instanceof RangeError;
    }
    assertEquals(mismatched, true, "batch mismatch");
  }
  const after = SimdMatrix3D.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
