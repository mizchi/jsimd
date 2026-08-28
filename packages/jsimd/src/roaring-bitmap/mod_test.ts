import { RoaringBitmap } from "../roaring-bitmap/mod.ts";
import { assertClose, assertEquals, rangeBy } from "../../test/assert.ts";

function sortedSet(values: Set<number>): string {
  return Uint32Array.from(values).sort().join(",");
}

Deno.test("RoaringBitmap supports the complete Uint32 key range", () => {
  using values = RoaringBitmap.from([0, 1, 65_535, 65_536, 70_000, 0xffff_ffff]);
  assertEquals(values.size, 6, "size");
  assertEquals(values.has(0), true, "zero");
  assertEquals(values.has(65_536), true, "second container");
  assertEquals(values.has(0xffff_ffff), true, "uint32 max");
  assertEquals(values.has(2), false, "missing");
  values.insert(1).remove(70_000).remove(70_000);
  assertEquals(values.size, 5, "idempotent mutation");
  assertEquals(values.toUint32Array().join(","), "0,1,65535,65536,4294967295", "sorted copy");
});

Deno.test("RoaringBitmap is the canonical adaptive-container API", () => {
  using bitmap = RoaringBitmap.from([1, 65_536, 0xffff_ffff]);
  assertEquals(bitmap instanceof RoaringBitmap, true, "canonical runtime type");
  assertEquals(bitmap.has(65_536), true, "membership");
});

Deno.test("RoaringBitmap converts containers at the 4096 threshold", () => {
  using values = new RoaringBitmap();
  for (let value = 0; value <= 4096; value++) values.insert(value);
  assertEquals(values.size, 4097, "bitmap size");
  for (const value of [0, 1, 4095, 4096]) assertEquals(values.has(value), true, `has ${value}`);
  values.remove(4096);
  assertEquals(values.size, 4096, "array size after shrinking");
  assertEquals(values.has(4095), true, "survives bitmap to array conversion");
});

Deno.test("RoaringBitmap computes non-materializing set queries", () => {
  using left = RoaringBitmap.from([1, 2, 65_535, 65_536, 65_537, 0xffff_ffff]);
  using right = RoaringBitmap.from([2, 65_536, 70_000, 0xffff_ffff]);
  assertEquals(left.andCardinality(right), 3, "intersection cardinality");
  assertEquals(left.intersects(right), true, "intersects");
  assertClose(left.jaccard(right), 3 / 7, 1e-12, "jaccard");
  using disjoint = RoaringBitmap.from([100, 200]);
  assertEquals(left.intersects(disjoint), false, "disjoint");
  using emptyLeft = new RoaringBitmap();
  using emptyRight = new RoaringBitmap();
  assertEquals(emptyLeft.jaccard(emptyRight), 1, "empty jaccard");
});

Deno.test("RoaringBitmap completes cardinality and materializing set algebra", () => {
  using left = RoaringBitmap.from([0, 1, 2, 65_535, 65_536, 70_000, 0xffff_ffff]);
  using right = RoaringBitmap.from([1, 3, 65_535, 65_537, 70_000]);

  assertEquals(left.orCardinality(right), 9, "union cardinality");
  assertEquals(left.xorCardinality(right), 6, "xor cardinality");
  assertEquals(left.andNotCardinality(right), 4, "difference cardinality");

  using union = left.or(right);
  using xor = left.xor(right);
  using difference = left.andNot(right);
  assertEquals(
    union.toUint32Array().join(","),
    "0,1,2,3,65535,65536,65537,70000,4294967295",
    "union values",
  );
  assertEquals(xor.toUint32Array().join(","), "0,2,3,65536,65537,4294967295", "xor values");
  assertEquals(
    difference.toUint32Array().join(","),
    "0,2,65536,4294967295",
    "difference values",
  );
});

Deno.test("RoaringBitmap set algebra covers every array and bitmap container pairing", () => {
  const cases: Array<[string, number[], number[]]> = [
    ["array-array", rangeBy(0, 4_000, 2), rangeBy(1, 4_000, 3)],
    ["array-bitmap", rangeBy(0, 4_000, 2), rangeBy(0, 7_000, 1)],
    ["bitmap-array", rangeBy(0, 7_000, 1), rangeBy(0, 4_000, 3)],
    ["bitmap-bitmap", rangeBy(0, 7_000, 1), rangeBy(1_000, 8_000, 1)],
  ];
  for (const [name, leftValues, rightValues] of cases) {
    using left = RoaringBitmap.from(leftValues);
    using right = RoaringBitmap.from(rightValues);
    const leftSet = new Set(leftValues);
    const rightSet = new Set(rightValues);
    const expectedUnion = new Set([...leftSet, ...rightSet]);
    const expectedXor = new Set(
      [...expectedUnion].filter((value) => leftSet.has(value) !== rightSet.has(value)),
    );
    const expectedDifference = new Set([...leftSet].filter((value) => !rightSet.has(value)));

    using union = left.or(right);
    using xor = left.xor(right);
    using difference = left.andNot(right);
    assertEquals(union.toUint32Array().join(","), sortedSet(expectedUnion), `${name} union`);
    assertEquals(xor.toUint32Array().join(","), sortedSet(expectedXor), `${name} xor`);
    assertEquals(
      difference.toUint32Array().join(","),
      sortedSet(expectedDifference),
      `${name} difference`,
    );
  }
});

Deno.test("RoaringBitmap set algebra handles empty, identical, and threshold results", () => {
  using empty = new RoaringBitmap();
  using dense = RoaringBitmap.from(rangeBy(0, 4_097, 1));
  using identicalXor = dense.xor(dense);
  using identicalDifference = dense.andNot(dense);
  using emptyUnion = empty.or(dense);
  assertEquals(identicalXor.size, 0, "identical xor");
  assertEquals(identicalDifference.size, 0, "identical difference");
  assertEquals(
    emptyUnion.toUint32Array().join(","),
    dense.toUint32Array().join(","),
    "empty union",
  );

  using one = RoaringBitmap.from([4_096]);
  using threshold = dense.andNot(one);
  assertEquals(threshold.size, 4_096, "bitmap result canonicalizes at threshold");
  threshold.insert(65_535);
  assertEquals(threshold.size, 4_097, "canonical array grows back to bitmap");
  assertEquals(threshold.has(65_535), true, "value survives threshold conversion");
});

Deno.test("RoaringBitmap reusable outputs reject aliases and release replaced containers", () => {
  const before = RoaringBitmap.allocatorStats();
  {
    using left = RoaringBitmap.from(rangeBy(0, 7_000, 1));
    using right = RoaringBitmap.from(rangeBy(3_000, 10_000, 1));
    using output = RoaringBitmap.from([0xffff_ffff]);
    assertEquals(left.orInto(right, output), output, "union output reuse");
    assertEquals(output.size, 10_000, "union output size");
    assertEquals(left.xorInto(right, output), output, "xor output reuse");
    assertEquals(output.size, 6_000, "xor output size");
    assertEquals(left.andNotInto(right, output), output, "difference output reuse");
    assertEquals(output.size, 3_000, "difference output size");

    for (const operation of ["orInto", "xorInto", "andNotInto"] as const) {
      let aliased = false;
      try {
        left[operation](right, left);
      } catch (error) {
        aliased = error instanceof RangeError;
      }
      assertEquals(aliased, true, `${operation} aliased output`);
    }
  }
  const after = RoaringBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "set algebra live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "set algebra live bytes");
});

Deno.test("RoaringBitmap batches membership into caller-owned output", () => {
  using values = RoaringBitmap.from([0, 2, 65_536, 0xffff_ffff]);
  const queries = new Uint32Array([0, 1, 2, 65_535, 65_536, 0xffff_ffff]);
  const output = new Uint8Array(queries.length + 2).fill(9);
  assertEquals(values.hasMany(queries, output), output, "membership output reuse");
  assertEquals(output.join(","), "1,0,1,0,1,1,9,9", "membership values and tail");
  const unsorted = new Uint32Array([0xffff_ffff, 0, 65_536, 2, 65_536]);
  const unsortedOutput = new Uint8Array(unsorted.length);
  values.hasMany(unsorted, unsortedOutput);
  assertEquals(unsortedOutput.join(","), "1,1,1,1,1", "unsorted and duplicate queries");
  let undersized = false;
  try {
    values.hasMany(queries, new Uint8Array(queries.length - 1));
  } catch (error) {
    undersized = error instanceof RangeError;
  }
  assertEquals(undersized, true, "undersized membership output");
});

Deno.test("RoaringBitmap writes values and inclusive ranges into caller-owned outputs", () => {
  using values = RoaringBitmap.from([1, 2, 3, 10, 12, 13, 65_536]);
  const positions = new Uint32Array(values.size + 1).fill(0xffff_ffff);
  assertEquals(values.valuesInto(positions), values.size, "value count");
  assertEquals(positions.join(","), "1,2,3,10,12,13,65536,4294967295", "value output tail");
  const starts = new Uint32Array(5).fill(0xffff_ffff);
  const ends = new Uint32Array(5).fill(0xffff_ffff);
  assertEquals(values.rangesInto(starts, ends), 4, "range count");
  assertEquals(starts.join(","), "1,10,12,65536,4294967295", "range starts");
  assertEquals(ends.join(","), "3,10,13,65536,4294967295", "range ends");
  let undersized = false;
  try {
    values.rangesInto(new Uint32Array(3), new Uint32Array(3));
  } catch (error) {
    undersized = error instanceof RangeError;
  }
  assertEquals(undersized, true, "undersized ranges");
});

Deno.test("RoaringBitmap andInto reuses output without aliasing", () => {
  using left = new RoaringBitmap();
  using right = new RoaringBitmap();
  for (let value = 0; value < 20_000; value++) {
    if (value % 3 === 0) left.insert(value);
    if (value % 5 === 0) right.insert(value);
  }
  using output = RoaringBitmap.from([0xffff_ffff]);
  assertEquals(left.andInto(right, output), output, "output reuse");
  assertEquals(output.size, 1_334, "intersection size");
  assertEquals(output.has(0), true, "first intersection");
  assertEquals(output.has(19_995), true, "last intersection");
  let aliased = false;
  try {
    left.andInto(right, left);
  } catch (error) {
    aliased = error instanceof RangeError;
  }
  assertEquals(aliased, true, "aliased output");
});

Deno.test("RoaringBitmap retains dense bitmap intersection results", () => {
  using left = new RoaringBitmap();
  using right = new RoaringBitmap();
  for (let value = 0; value <= 6_000; value++) left.insert(value);
  for (let value = 1_000; value <= 7_000; value++) right.insert(value);
  using output = left.and(right);
  assertEquals(output.size, 5_001, "dense intersection size");
  assertEquals(output.has(999), false, "before dense result");
  assertEquals(output.has(1_000), true, "dense result start");
  assertEquals(output.has(6_000), true, "dense result end");
  assertEquals(output.has(6_001), false, "after dense result");
  assertEquals(left.andCardinality(right), 5_001, "dense count");
});

Deno.test("RoaringBitmap emits maximal inclusive ranges", () => {
  using values = RoaringBitmap.from([
    1,
    2,
    3,
    65_535,
    65_536,
    65_537,
    100_000,
    100_002,
  ]);
  const ranges: string[] = [];
  values.forEachRange((start, end) => ranges.push(`${start}-${end}`));
  assertEquals(ranges.join(","), "1-3,65535-65537,100000-100000,100002-100002", "ranges");
});

Deno.test("RoaringBitmap matches Set on randomized operations", () => {
  using actual = new RoaringBitmap();
  const expected = new Set<number>();
  let state = 0x1234_abcd;
  for (let operation = 0; operation < 20_000; operation++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const value = operation % 3 === 0 ? state : state & 0x3ffff;
    if ((state & 8) === 0) {
      actual.insert(value);
      expected.add(value);
    } else {
      actual.remove(value);
      expected.delete(value);
    }
  }
  const sorted = Uint32Array.from(expected).sort();
  assertEquals(actual.size, expected.size, "random size");
  assertEquals(actual.toUint32Array().join(","), sorted.join(","), "random contents");
});

Deno.test("RoaringBitmap using lifecycle returns every container allocation", () => {
  const before = RoaringBitmap.allocatorStats();
  {
    using values = new RoaringBitmap();
    for (let value = 0; value < 200_000; value += 3) values.insert(value);
    assertEquals(values.has(199_998), true, "live set");
  }
  const after = RoaringBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("RoaringBitmap releases partial construction after invalid input", () => {
  const before = RoaringBitmap.allocatorStats();
  let threw = false;
  try {
    RoaringBitmap.from([1, 65_536, -1]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "invalid Uint32");
  const after = RoaringBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "partial allocations");
  assertEquals(after.liveBytes, before.liveBytes, "partial bytes");
});
