import { SimdInt32Array } from "../i32-array/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("SimdInt32Array exposes fixed storage and SIMD reductions", () => {
  using values = SimdInt32Array.from([5, -7, 11, 0, 2]);
  assertEquals(values.length, 5, "length");
  assertEquals(values.get(1), -7, "get");
  values.set(3, 13);
  assertEquals(values.sum(), 24, "sum");
  assertEquals(values.min(), -7, "min");
  assertEquals(values.max(), 13, "max");
  assertEquals(values.toInt32Array().join(","), "5,-7,11,13,2", "copy out");
});

Deno.test("SimdInt32Array performs fixed-length compound operations", () => {
  using left = SimdInt32Array.from([1, 2, 3, 4, 5]);
  using right = SimdInt32Array.from([10, 20, 30, 40, 50]);
  using equal = SimdInt32Array.from([1, 2, 3, 4, 5]);
  assertEquals(left.equals(equal), true, "equal");
  assertEquals(left.equals(right), false, "different");
  left.addAssign(right);
  assertEquals(left.toInt32Array().join(","), "11,22,33,44,55", "in-place add");
  left.fill(-3);
  assertEquals(left.sum(), -15, "fill");
});

Deno.test("SimdInt32Array preserves wide sums and validates contracts", () => {
  using values = SimdInt32Array.from([0x7fff_ffff, 0x7fff_ffff, -0x8000_0000]);
  assertEquals(values.sum(), 2_147_483_646, "i64 accumulation");
  using empty = new SimdInt32Array(0);
  assertEquals(empty.sum(), 0, "empty sum");
  let threw = false;
  try {
    empty.min();
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "empty min");
});

Deno.test("SimdInt32Array using lifecycle returns allocator storage", () => {
  const before = SimdInt32Array.allocatorStats();
  {
    using values = new SimdInt32Array(1024);
    values.fill(1);
    assertEquals(values.sum(), 1024, "live value");
  }
  const after = SimdInt32Array.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdInt32Array releases allocation when from throws", () => {
  const before = SimdInt32Array.allocatorStats();
  const values = {
    length: 4,
    get 0(): number {
      throw new Error("input failed");
    },
  } as ArrayLike<number>;
  let threw = false;
  try {
    SimdInt32Array.from(values);
  } catch (error) {
    threw = error instanceof Error && error.message === "input failed";
  }
  assertEquals(threw, true, "source error");
  const after = SimdInt32Array.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdInt32Array matches Int32Array across SIMD tails", () => {
  let state = 0x1234_5678;
  for (const length of [0, 1, 3, 4, 5, 15, 16, 17, 63, 64, 65, 1025]) {
    const values = Int32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      return state;
    });
    using actual = SimdInt32Array.from(values);
    let expectedSum = 0;
    let expectedMin = values[0];
    let expectedMax = values[0];
    for (const value of values) {
      expectedSum += value;
      if (value < expectedMin!) expectedMin = value;
      if (value > expectedMax!) expectedMax = value;
    }
    assertEquals(actual.sum(), expectedSum, `sum length=${length}`);
    if (length > 0) {
      assertEquals(actual.min(), expectedMin, `min length=${length}`);
      assertEquals(actual.max(), expectedMax, `max length=${length}`);
    }
  }
});
