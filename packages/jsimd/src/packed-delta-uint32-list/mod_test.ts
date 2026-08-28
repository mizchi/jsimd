import {
  PackedDeltaUint32List,
  PackedDeltaUint32ListBuilder,
} from "../packed-delta-uint32-list/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("PackedDeltaUint32List preserves monotone Uint32 values", () => {
  const values = [0, 1, 255, 256, 65_535, 0x7fff_ffff, 0xffff_ffff];
  using packed = PackedDeltaUint32List.from(values);
  assertEquals(packed.length, values.length, "length");
  for (let index = 0; index < values.length; index++) {
    assertEquals(packed.at(index), values[index], `at ${index}`);
  }
  assertEquals(packed.toUint32Array().join(","), values.join(","), "full decode");
});

Deno.test("PackedDeltaUint32List implements lower-bound and nextGEQ", () => {
  using packed = PackedDeltaUint32List.from([1, 5, 9, 100, 0xffff_ffff]);
  assertEquals(packed.lowerBound(0), 0, "before first");
  assertEquals(packed.lowerBound(1), 0, "exact first");
  assertEquals(packed.lowerBound(6), 2, "between");
  assertEquals(packed.lowerBound(0xffff_ffff), 4, "exact max");
  assertEquals(packed.nextGEQ(6), 9, "next value");
  assertEquals(packed.nextGEQ(0xffff_ffff), 0xffff_ffff, "next max");
  assertEquals(packed.nextGEQ(101), 0xffff_ffff, "next wide delta");
});

Deno.test("PackedDeltaUint32List decodes ranges into reusable output", () => {
  const values = Uint32Array.from({ length: 300 }, (_, index) => index * index + index);
  using packed = PackedDeltaUint32List.from(values);
  const output = new Uint32Array(17);
  assertEquals(packed.decodeInto(127, output), 17, "decoded count");
  assertEquals(output.join(","), values.slice(127, 144).join(","), "128-boundary decode");
  assertEquals(packed.decodeInto(295, output), 5, "tail count");
  assertEquals(output.slice(0, 5).join(","), values.slice(295).join(","), "tail values");
});

Deno.test("PackedDeltaUint32List intersects without full materialization", () => {
  using left = PackedDeltaUint32List.from([1, 3, 7, 9, 100, 1_000, 0xffff_ffff]);
  using right = PackedDeltaUint32List.from([0, 3, 4, 9, 1_000, 2_000, 0xffff_ffff]);
  const output = new Uint32Array(8);
  assertEquals(left.intersectInto(right, output), 4, "intersection count");
  assertEquals(output.slice(0, 4).join(","), "3,9,1000,4294967295", "intersection values");
  const truncated = new Uint32Array(2);
  assertEquals(left.intersectInto(right, truncated), 2, "bounded intersection count");
  assertEquals(truncated.join(","), "3,9", "bounded intersection values");
});

Deno.test("PackedDeltaUint32List intersection matches randomized sorted arrays", () => {
  let state = 0x2468_ace0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  for (let round = 0; round < 32; round++) {
    const leftValues: number[] = [];
    const rightValues: number[] = [];
    for (let value = 0; value < 2_000; value++) {
      if ((random() & 7) === 0) leftValues.push(value * 65_537);
      if ((random() & 15) === 0) rightValues.push(value * 65_537);
    }
    using left = PackedDeltaUint32List.from(leftValues);
    using right = PackedDeltaUint32List.from(rightValues);
    const expected = leftValues.filter((value) => rightValues.includes(value));
    const output = new Uint32Array(Math.max(1, expected.length));
    const count = left.intersectInto(right, output);
    assertEquals(count, expected.length, `random intersection count ${round}`);
    assertEquals(
      output.slice(0, count).join(","),
      expected.join(","),
      `random intersection values ${round}`,
    );
  }
});

Deno.test("PackedDeltaUint32ListBuilder freezes strict snapshots", () => {
  const builder = new PackedDeltaUint32ListBuilder();
  builder.append(10).append(20).append(30);
  using first = builder.freeze();
  builder.append(40);
  using second = builder.freeze();
  assertEquals(first.toUint32Array().join(","), "10,20,30", "first snapshot");
  assertEquals(second.toUint32Array().join(","), "10,20,30,40", "second snapshot");
  let duplicate = false;
  try {
    builder.append(40);
  } catch (error) {
    duplicate = error instanceof RangeError;
  }
  assertEquals(duplicate, true, "strictly increasing input");
});

Deno.test("PackedDeltaUint32List matches randomized monotone values", () => {
  const values: number[] = [];
  let state = 0x1357_9bdf;
  let value = 0;
  for (let index = 0; index < 2_000; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const delta = (state & 0x3ff) + 1;
    if (value + delta > 0xffff_ffff) break;
    value += delta;
    values.push(value);
  }
  using packed = PackedDeltaUint32List.from(values);
  for (let index = 0; index < values.length; index += 17) {
    assertEquals(packed.at(index), values[index], `random at ${index}`);
    assertEquals(packed.lowerBound(values[index]!), index, `random lower bound ${index}`);
  }
  assertEquals(packed.toUint32Array().join(","), values.join(","), "random decode");
});

Deno.test("PackedDeltaUint32List using lifecycle returns compressed allocations", () => {
  const before = PackedDeltaUint32List.allocatorStats();
  {
    using packed = PackedDeltaUint32List.from(
      Uint32Array.from({ length: 10_000 }, (_, index) => index * 3),
    );
    assertEquals(packed.at(9_999), 29_997, "live packed value");
    if (packed.compressedBytes >= packed.length * 4) {
      throw new Error(`small deltas did not compress: ${packed.compressedBytes}`);
    }
  }
  const after = PackedDeltaUint32List.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
