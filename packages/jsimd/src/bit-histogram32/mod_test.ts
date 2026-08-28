import { BitHistogram32, bitHistogram32 } from "../bit-histogram32/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("BitHistogram32 counts every bit across chunks and resets", () => {
  const values = new Uint32Array([0, 1, 3, 0xffff_ffff, 0x8000_0000]);
  const expected = new Uint32Array(32).fill(1);
  expected[0] = 3;
  expected[1] = 2;
  expected[31] = 2;

  const oneShot = new Uint32Array(32);
  assertEquals(bitHistogram32(values, oneShot), oneShot, "one-shot output identity");
  assertEquals(oneShot.join(","), expected.join(","), "one-shot histogram");

  const before = BitHistogram32.allocatorStats();
  {
    using histogram = new BitHistogram32();
    histogram.add(values.subarray(0, 2)).add(values.subarray(2));
    const chunked = new Uint32Array(32);
    assertEquals(histogram.writeInto(chunked), chunked, "resident output identity");
    assertEquals(chunked.join(","), expected.join(","), "chunked histogram");
    histogram.reset().writeInto(chunked);
    assertEquals(chunked.every((count) => count === 0), true, "reset histogram");
  }
  const after = BitHistogram32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "histogram allocations");
  assertEquals(after.liveBytes, before.liveBytes, "histogram bytes");
});

Deno.test("BitHistogram32 matches scalar positional counts across flush tails", () => {
  for (const length of [0, 1, 17, 254, 255, 256, 1023]) {
    const values = Uint32Array.from(
      { length },
      (_, index) => Math.imul(index + 1, 0x9e37_79b1) >>> 0,
    );
    const expected = new Uint32Array(32);
    for (const value of values) {
      for (let bit = 0; bit < 32; bit++) expected[bit] += (value >>> bit) & 1;
    }
    using histogram = new BitHistogram32();
    for (let offset = 0; offset < length; offset += 113) {
      histogram.add(values.subarray(offset, Math.min(length, offset + 113)));
    }
    const actual = new Uint32Array(32);
    histogram.writeInto(actual);
    assertEquals(actual.join(","), expected.join(","), `histogram n=${length}`);
    assertEquals(histogram.length, length, `histogram length n=${length}`);
  }
});
