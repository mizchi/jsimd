import { WaveletMatrixUint8 } from "../wavelet-matrix-uint8/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("WaveletMatrixUint8 specializes wavelet queries to the byte alphabet", () => {
  using matrix = WaveletMatrixUint8.from(Uint8Array.of(98, 97, 110, 97, 110, 97, 0, 255));
  assertEquals(matrix.length, 8, "length");
  assertEquals(matrix.levels, 8, "byte levels");
  assertEquals(matrix.access(3), 97, "access");
  assertEquals(matrix.rank(97, 6), 3, "rank");
  assertEquals(matrix.select(110, 1), 4, "select");
  assertEquals(matrix.rangeFreq(0, 8, 97, 111), 6, "range frequency");
  assertEquals(matrix.quantile(0, 8, 0), 0, "quantile");
  assertEquals(matrix.predecessor(0, 8, 98), 97, "predecessor");
});

Deno.test("WaveletMatrixUint8 batches byte access, rank, and quantile", () => {
  using matrix = WaveletMatrixUint8.from(Uint8Array.of(9, 1, 7, 1, 5, 1, 3));
  assertEquals(matrix.accessMany(Uint32Array.of(6, 0, 3)).join(","), "3,9,1", "accessMany");
  assertEquals(
    matrix.rankMany(Uint8Array.of(1, 7, 9), Uint32Array.of(7, 4, 1)).join(","),
    "3,1,1",
    "rankMany",
  );
  assertEquals(
    matrix.quantileMany(
      Uint32Array.of(0, 1),
      Uint32Array.of(7, 6),
      Uint32Array.of(3, 2),
    ).join(","),
    "3,1",
    "quantileMany",
  );
});

Deno.test("WaveletMatrixUint8 using lifecycle returns allocator storage", () => {
  const before = WaveletMatrixUint8.allocatorStats();
  {
    using matrix = WaveletMatrixUint8.from(new Uint8Array(100_000));
    assertEquals(matrix.rank(0, matrix.length), matrix.length, "resident query");
  }
  const after = WaveletMatrixUint8.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("WaveletMatrixUint8 matches scalar randomized byte queries", () => {
  let state = 0x1234_abcd;
  const values = Uint8Array.from({ length: 2_057 }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state >>> 24;
  });
  using matrix = WaveletMatrixUint8.from(values);
  for (let query = 0; query < 500; query++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const left = state % values.length;
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const right = left + (state % (values.length - left + 1));
    const value = state & 0xff;
    let rank = 0;
    for (let index = 0; index < right; index++) rank += Number(values[index] === value);
    assertEquals(matrix.rank(value, right), rank, `rank query=${query}`);
    if (right > left) {
      const sorted = values.slice(left, right).sort();
      const kth = state % sorted.length;
      assertEquals(matrix.quantile(left, right, kth), sorted[kth], `quantile query=${query}`);
    }
  }
});
