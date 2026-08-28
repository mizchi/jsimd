import { indexOf } from "../bytes/mod.ts";
import { Bitmap, DenseBitmap } from "../bitmap/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("DenseBitmap handles boundaries and set algebra", () => {
  const left = DenseBitmap.from(130, [0, 31, 32, 63, 64, 127, 129]);
  const right = DenseBitmap.from(130, [1, 31, 63, 65, 127]);
  assertEquals(left.has(129), true, "last bit");
  assertEquals(left.has(128), false, "unset bit");
  assertEquals(left.countOnes(), 7, "left cardinality");
  assertEquals(left.intersectionCount(right), 3, "intersection cardinality");
  assertEquals(left.isDisjoint(right), false, "overlap");

  const intersection = left.clone().intersectWith(right);
  assertEquals(intersection.toArray().join(","), "31,63,127", "intersection");
  const union = left.clone().unionWith(right);
  assertEquals(union.toArray().join(","), "0,1,31,32,63,64,65,127,129", "union");
  const difference = left.clone().differenceWith(right);
  assertEquals(difference.toArray().join(","), "0,32,64,129", "difference");
  const symmetric = left.clone().symmetricDifferenceWith(right);
  assertEquals(symmetric.toArray().join(","), "0,1,32,64,65,129", "symmetric difference");
});

Deno.test("Bitmap and DenseBitmap expose growable and fixed-universe contracts", () => {
  using growable = Bitmap.from([1, 130]);
  growable.insert(10_000);
  assertEquals(growable.has(10_000), true, "growable bitmap");

  using left = DenseBitmap.from(256, [1, 3, 130]);
  using right = DenseBitmap.from(256, [3, 4, 130]);
  left.intersectWith(right);
  assertEquals(left.toArray().join(","), "3,130", "fixed dense intersection");
});

Deno.test("DenseBitmap validates capacity and ignores padded tail bits", () => {
  const bits = new DenseBitmap(33).insert(32);
  assertEquals(bits.countOnes(), 1, "tail cardinality");
  assertEquals(bits.toArray().join(","), "32", "tail enumeration");
  let threw = false;
  try {
    bits.insert(33);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "out of bounds");
});

Deno.test("DenseBitmap storage remains intact across scratch-memory kernels", () => {
  const bits = DenseBitmap.from(1024, [0, 511, 1023]);
  const input = new Uint8Array(4096).fill(0x61);
  assertEquals(indexOf(input, 0x7a), -1, "scratch scan");
  assertEquals(bits.toArray().join(","), "0,511,1023", "persistent storage");

  // Allocate after scratch use as well, since the regions grow independently.
  const later = DenseBitmap.from(65_537, [65_536]);
  assertEquals(later.countOnes(), 1, "allocation after scratch");
});

Deno.test("DenseBitmap SIMD operations match Set on randomized inputs", () => {
  let state = 0x1234_5678;
  for (const capacity of [0, 1, 31, 32, 33, 127, 128, 129, 4097]) {
    const leftSet = new Set<number>();
    const rightSet = new Set<number>();
    for (let index = 0; index < capacity; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 3) === 0) leftSet.add(index);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 7) === 0) rightSet.add(index);
    }
    const left = DenseBitmap.from(capacity, leftSet);
    const right = DenseBitmap.from(capacity, rightSet);
    const expectedUnion = new Set([...leftSet, ...rightSet]);
    const expectedIntersection = [...leftSet].filter((bit) => rightSet.has(bit));
    assertEquals(left.countOnes(), leftSet.size, `count capacity=${capacity}`);
    assertEquals(
      left.intersectionCount(right),
      expectedIntersection.length,
      `and count=${capacity}`,
    );
    assertEquals(
      left.clone().unionWith(right).toArray().join(","),
      [...expectedUnion].sort((a, b) => a - b).join(","),
      `union capacity=${capacity}`,
    );
  }
});

Deno.test("DenseBitmap dispose reuses storage and reports allocator state", () => {
  const before = DenseBitmap.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    DenseBitmap.from(4096, [0, 4095]).dispose();
  }
  const after = DenseBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bitset live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bitset live bytes");
  if (after.reservedBytes > before.reservedBytes + 512) {
    throw new Error(
      `bitset storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
  const disposed = new DenseBitmap(64);
  disposed.dispose();
  let threw = false;
  try {
    disposed.countOnes();
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(threw, true, "bitset use after dispose");
});

Deno.test("Bitmap grows on insertion and preserves existing bits", () => {
  using bits = Bitmap.from([0, 31, 32, 129, 65_536]);
  assertEquals(bits.has(65_536), true, "grown bit");
  assertEquals(bits.has(1_000_000), false, "membership outside allocated capacity");
  assertEquals(bits.countOnes(), 5, "cardinality after growth");
  assertEquals(bits.toArray().join(","), "0,31,32,129,65536", "ordered values");

  bits.remove(1_000_000).remove(32);
  assertEquals(bits.toArray().join(","), "0,31,129,65536", "out-of-range removal is a no-op");
});

Deno.test("Bitmap algebra accepts different capacities", () => {
  using small = Bitmap.from([1, 31, 130]);
  using large = Bitmap.from([31, 129, 65_536]);
  using union = small.clone().unionWith(large);
  using intersection = small.clone().intersectWith(large);
  using reverseIntersection = large.clone().intersectWith(small);
  using difference = large.clone().differenceWith(small);
  using symmetric = small.clone().symmetricDifferenceWith(large);

  assertEquals(union.toArray().join(","), "1,31,129,130,65536", "dynamic union");
  assertEquals(intersection.toArray().join(","), "31", "dynamic intersection");
  assertEquals(reverseIntersection.toArray().join(","), "31", "dynamic reverse intersection");
  assertEquals(difference.toArray().join(","), "129,65536", "dynamic difference");
  assertEquals(symmetric.toArray().join(","), "1,129,130,65536", "dynamic xor");
  assertEquals(small.intersectionCount(large), 1, "dynamic intersection count");
});

Deno.test("Bitmap using cleanup returns all resized allocations", () => {
  const before = Bitmap.allocatorStats();
  {
    using bits = new Bitmap();
    for (const bit of [0, 128, 4096, 65_536]) bits.insert(bit);
  }
  const after = Bitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "dynamic bitset allocations");
  assertEquals(after.liveBytes, before.liveBytes, "dynamic bitset bytes");
});

Deno.test("bitmap positionsInto writes exact positions without replacing output", () => {
  using dense = DenseBitmap.from(130, [0, 31, 32, 129]);
  using growable = Bitmap.from([1, 64, 1_000]);
  const denseOutput = new Uint32Array(5).fill(0xffff_ffff);
  const growableOutput = new Uint32Array(4).fill(0xffff_ffff);
  assertEquals(dense.positionsInto(denseOutput), 4, "dense written count");
  assertEquals(denseOutput.join(","), "0,31,32,129,4294967295", "dense positions");
  assertEquals(growable.positionsInto(growableOutput), 3, "growable written count");
  assertEquals(growableOutput.join(","), "1,64,1000,4294967295", "growable positions");
  let undersized = false;
  try {
    dense.positionsInto(new Uint32Array(3));
  } catch (error) {
    undersized = error instanceof RangeError;
  }
  assertEquals(undersized, true, "undersized bitmap positions");
});
