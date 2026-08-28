import { BitSlicedColumnU8, BitSliceMask } from "../bit-sliced-column/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("BitSlicedColumnU8 scans equality and unsigned ranges", () => {
  using column = BitSlicedColumnU8.from(new Uint8Array([0, 1, 2, 3, 7, 15, 16, 31]), 5);
  using mask = new BitSliceMask(column.length);
  column.eq(3, mask);
  assertEquals(mask.toIndices().join(","), "3", "eq");
  column.lt(7, mask);
  assertEquals(mask.toIndices().join(","), "0,1,2,3", "lt");
  column.between(3, 16, mask);
  assertEquals(mask.toIndices().join(","), "3,4,5,6", "inclusive between");
  assertEquals(column.get(7), 31, "point access");
});

Deno.test("BitSlicedColumnU8 keeps nulls separate from encoded values", () => {
  const values = new Uint8Array([0, 0, 1, 2, 0]);
  const validity = new Uint8Array([1, 0, 1, 1, 0]);
  using column = BitSlicedColumnU8.from(values, 2, validity);
  using mask = new BitSliceMask(values.length);
  column.eq(0, mask);
  assertEquals(mask.toIndices().join(","), "0", "null is not zero");
  assertEquals(column.get(1), undefined, "null point access");
  column.lt(3, mask);
  assertEquals(mask.toIndices().join(","), "0,2,3", "predicates exclude nulls");
});

Deno.test("BitSliceMask composes resident predicate results", () => {
  using left = BitSlicedColumnU8.from(new Uint8Array([1, 4, 7, 10, 13, 16]), 5);
  using right = BitSlicedColumnU8.from(new Uint8Array([0, 1, 0, 1, 0, 1]), 1);
  using range = new BitSliceMask(left.length);
  using active = new BitSliceMask(left.length);
  left.between(4, 13, range);
  right.eq(1, active);
  range.andAssign(active);
  assertEquals(range.toIndices().join(","), "1,3", "and composition");
  assertEquals(range.countOnes(), 2, "composed cardinality");
});

Deno.test("BitSlicedColumnU8 matches scalar scans across SIMD tails", () => {
  let state = 0x1020_3040;
  for (const length of [0, 1, 31, 32, 33, 127, 128, 129, 1_003]) {
    const values = Uint8Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state & 31;
    });
    using column = BitSlicedColumnU8.from(values, 5);
    using mask = new BitSliceMask(length);
    for (const query of [0, 1, 7, 16, 31, 32]) {
      column.eq(query, mask);
      const eq = Array.from(values.entries()).filter(([, value]) => value === query).map(([i]) =>
        i
      );
      assertEquals(mask.toIndices().join(","), eq.join(","), `eq ${length}/${query}`);
      column.lt(query, mask);
      const lt = Array.from(values.entries()).filter(([, value]) => value < query).map(([i]) => i);
      assertEquals(mask.toIndices().join(","), lt.join(","), `lt ${length}/${query}`);
    }
  }
});

Deno.test("BitSlicedColumn and masks release using-owned allocations", () => {
  const before = BitSlicedColumnU8.allocatorStats();
  {
    using column = BitSlicedColumnU8.from(
      Uint8Array.from({ length: 10_000 }, (_, index) => index & 15),
      4,
    );
    using mask = new BitSliceMask(column.length);
    column.eq(7, mask);
    assertEquals(mask.countOnes(), 625, "live cardinality");
  }
  const after = BitSlicedColumnU8.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bit-sliced allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bit-sliced bytes");
});
