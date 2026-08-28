import { SimdFloat32Vector } from "../f32-vector/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("SimdFloat32Vector computes dot product across SIMD boundaries", () => {
  for (const length of [0, 1, 3, 4, 5, 15, 16, 17, 1025]) {
    const leftValues = Float32Array.from({ length }, (_, index) => (index % 13) - 6.25);
    const rightValues = Float32Array.from({ length }, (_, index) => (index % 7) * 0.5 - 1.5);
    let expected = 0;
    for (let index = 0; index < length; index++) {
      expected += leftValues[index]! * rightValues[index]!;
    }
    const left = SimdFloat32Vector.from(leftValues);
    const right = SimdFloat32Vector.from(rightValues);
    assertClose(
      left.dot(right),
      expected,
      Math.max(1e-5, Math.abs(expected) * 1e-5),
      `n=${length}`,
    );
  }
});

Deno.test("SimdFloat32Vector performs in-place AXPY without exposing padding", () => {
  const target = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4, 5]));
  const source = SimdFloat32Vector.from(new Float32Array([2, -1, 0.5, 10, -2]));
  target.addScaled(source, 0.25);
  const actual = target.toFloat32Array();
  const expected = [1.5, 1.75, 3.125, 6.5, 4.5];
  assertEquals(actual.length, expected.length, "logical length");
  for (let index = 0; index < expected.length; index++) {
    assertClose(actual[index]!, expected[index]!, 1e-6, `lane=${index}`);
  }
});

Deno.test("SimdFloat32Vector computes resident distance, norm, and cosine", () => {
  using left = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4, 5]));
  using right = SimdFloat32Vector.from(new Float32Array([5, 4, 3, 2, 1]));
  assertClose(left.squaredDistance(right), 40, 1e-5, "squared distance");
  assertClose(left.norm(), Math.sqrt(55), 1e-5, "norm");
  assertClose(left.cosineSimilarity(right), 35 / 55, 1e-5, "cosine");
});

Deno.test("SimdFloat32Vector defines zero-norm cosine as NaN", () => {
  using zero = SimdFloat32Vector.from(new Float32Array(5));
  using value = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4, 5]));
  assertEquals(zero.norm(), 0, "zero norm");
  assertEquals(Number.isNaN(zero.cosineSimilarity(value)), true, "left zero cosine");
  assertEquals(Number.isNaN(value.cosineSimilarity(zero)), true, "right zero cosine");
});

Deno.test("SimdFloat32Vector dispose reuses storage and rejects later access", () => {
  const before = SimdFloat32Vector.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const vector = SimdFloat32Vector.from(new Float32Array(1024));
    vector.dispose();
    vector.dispose(); // Idempotent cleanup is convenient in finally blocks.
  }
  const after = SimdFloat32Vector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "vector live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "vector live bytes");
  if (after.reservedBytes > before.reservedBytes + 4096) {
    throw new Error(
      `vector storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
  const disposed = new SimdFloat32Vector(4);
  disposed.dispose();
  let threw = false;
  try {
    disposed.toFloat32Array();
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(threw, true, "vector use after dispose");
});
