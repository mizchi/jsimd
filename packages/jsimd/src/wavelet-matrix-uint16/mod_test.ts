import { WaveletMatrixUint16 } from "../wavelet-matrix-uint16/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("WaveletMatrixUint16 supports the complete code-unit domain", () => {
  const values = Uint16Array.of(0xffff, 0, 0x8000, 97, 0xffff, 97, 0x1234);
  using matrix = WaveletMatrixUint16.from(values);
  assertEquals(matrix.length, values.length, "length");
  assertEquals(matrix.levels, 16, "levels");
  assertEquals(matrix.access(0), 0xffff, "maximum access");
  assertEquals(matrix.rank(97, values.length), 2, "rank");
  assertEquals(matrix.select(0xffff, 1), 4, "select");
  assertEquals(matrix.rangeFreq(0, values.length, 0x8000, 0x1_0000), 3, "upper range");
  assertEquals(matrix.quantile(0, values.length, 0), 0, "minimum");
  assertEquals(matrix.predecessor(0, values.length, 0x1_0000), 0xffff, "maximum predecessor");
});

Deno.test("WaveletMatrixUint16 batches access, rank, and quantile", () => {
  using matrix = WaveletMatrixUint16.from(Uint16Array.of(900, 1, 700, 1, 500, 1, 300));
  assertEquals(matrix.accessMany(Uint32Array.of(6, 0, 3)).join(","), "300,900,1", "accessMany");
  assertEquals(
    matrix.rankMany(Uint16Array.of(1, 700, 900), Uint32Array.of(7, 4, 1)).join(","),
    "3,1,1",
    "rankMany",
  );
  assertEquals(
    matrix.quantileMany(
      Uint32Array.of(0, 1),
      Uint32Array.of(7, 6),
      Uint32Array.of(3, 2),
    ).join(","),
    "300,1",
    "quantileMany",
  );
});

Deno.test("WaveletMatrixUint16 validates values and returns allocator storage", () => {
  const before = WaveletMatrixUint16.allocatorStats();
  {
    using matrix = WaveletMatrixUint16.from(new Uint16Array(10_000));
    assertEquals(matrix.rank(0, matrix.length), matrix.length, "resident query");
  }
  let threw = false;
  try {
    WaveletMatrixUint16.from([0x1_0000]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "invalid Uint16 input");
  const after = WaveletMatrixUint16.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("WaveletMatrixUint16 matches randomized scalar range queries and snapshots", () => {
  let state = 0x9e37_79b9;
  const values = Uint16Array.from({ length: 2_057 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 16;
  });
  let snapshot: Uint8Array;
  {
    using matrix = WaveletMatrixUint16.from(values);
    snapshot = matrix.serialize();
  }
  using matrix = WaveletMatrixUint16.fromSnapshot(snapshot);
  for (let query = 0; query < 200; query++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const left = state % values.length;
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const right = left + 1 + (state % (values.length - left));
    const sorted = values.slice(left, right).sort();
    const kth = state % sorted.length;
    assertEquals(matrix.quantile(left, right, kth), sorted[kth], `quantile ${query}`);

    const bound = state >>> 16;
    let expected = 0;
    for (let index = left; index < right; index++) expected += Number(values[index]! < bound);
    assertEquals(matrix.rangeFreq(left, right, 0, bound), expected, `rangeFreq ${query}`);
  }
});
