import { WaveletMatrixUint32 } from "../wavelet-matrix-uint32/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("WaveletMatrixUint32 supports access, rank, and select", () => {
  const values = Uint32Array.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  using matrix = WaveletMatrixUint32.from(values);
  assertEquals(matrix.length, values.length, "wavelet length");
  for (let index = 0; index < values.length; index++) {
    assertEquals(matrix.access(index), values[index], `wavelet access ${index}`);
  }
  assertEquals(matrix.rank(1, 4), 2, "rank [0,end)");
  assertEquals(matrix.rank(5, values.length), 2, "rank duplicate");
  assertEquals(matrix.select(1, 0), 1, "first one");
  assertEquals(matrix.select(1, 1), 3, "second one");
  assertEquals(matrix.select(1, 2), -1, "missing occurrence");
});

Deno.test("WaveletMatrixUint32 supports range statistics", () => {
  using matrix = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  assertEquals(matrix.rangeFreq(0, 9, 2, 6), 5, "values in [2,6)");
  assertEquals(matrix.rangeFreq(2, 8, 0, 0x1_0000_0000), 6, "full Uint32 range");
  assertEquals(matrix.quantile(0, 9, 0), 1, "minimum");
  assertEquals(matrix.quantile(0, 9, 4), 4, "median");
  assertEquals(matrix.quantile(2, 8, 5), 9, "subrange maximum");
  assertEquals(matrix.predecessor(0, 9, 5), 4, "strict predecessor");
  assertEquals(matrix.predecessor(0, 9, 1), -1, "missing predecessor");
});

Deno.test("WaveletMatrixUint32 preserves the complete Uint32 domain", () => {
  using matrix = WaveletMatrixUint32.from([0xffff_ffff, 0, 0x8000_0000, 0xffff_ffff]);
  assertEquals(matrix.access(0), 0xffff_ffff, "Uint32 max access");
  assertEquals(matrix.quantile(0, 4, 2), 0xffff_ffff, "unsigned quantile");
  assertEquals(matrix.rank(0xffff_ffff, 4), 2, "Uint32 max rank");
  assertEquals(matrix.predecessor(0, 4, 0x1_0000_0000), 0xffff_ffff, "full-range max");
});

Deno.test("WaveletMatrixUint32 batches independent queries", () => {
  using matrix = WaveletMatrixUint32.from([7, 2, 9, 2, 4, 8]);
  const accessOutput = new Uint32Array(3);
  matrix.accessMany(new Uint32Array([5, 0, 3]), accessOutput);
  assertEquals(accessOutput.join(","), "8,7,2", "accessMany");

  const rankOutput = new Uint32Array(3);
  matrix.rankMany(new Uint32Array([2, 9, 7]), new Uint32Array([4, 6, 1]), rankOutput);
  assertEquals(rankOutput.join(","), "2,1,1", "rankMany");

  const quantileOutput = new Uint32Array(3);
  matrix.quantileMany(
    new Uint32Array([0, 1, 0]),
    new Uint32Array([6, 5, 6]),
    new Uint32Array([0, 2, 5]),
    quantileOutput,
  );
  assertEquals(quantileOutput.join(","), "2,4,9", "quantileMany");
});

Deno.test("WaveletMatrixUint32 matches scalar randomized range queries", () => {
  let state = 0x6d2b_79f5;
  for (const length of [0, 1, 31, 32, 127, 128, 129, 1025]) {
    const values = Uint32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    });
    using matrix = WaveletMatrixUint32.from(values);
    for (let query = 0; query < 40; query++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const left = length === 0 ? 0 : state % (length + 1);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const right = left + (length === left ? 0 : state % (length - left + 1));
      if (left === right) continue;
      const sorted = Array.from(values.slice(left, right)).sort((a, b) => a - b);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const kth = state % sorted.length;
      assertEquals(matrix.quantile(left, right, kth), sorted[kth], `quantile ${length}/${query}`);
      const bound = state;
      const expectedFreq = sorted.filter((value) => value < bound).length;
      assertEquals(
        matrix.rangeFreq(left, right, 0, bound),
        expectedFreq,
        `rangeFreq ${length}/${query}`,
      );
    }
  }
});

Deno.test("WaveletMatrixUint32 randomized rank and select preserve duplicates", () => {
  let state = 0x243f_6a88;
  const values = Uint32Array.from({ length: 1025 }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state & 31;
  });
  using matrix = WaveletMatrixUint32.from(values);
  for (let value = 0; value < 32; value++) {
    const positions: number[] = [];
    for (let index = 0; index < values.length; index++) {
      if (values[index] === value) positions.push(index);
    }
    for (const end of [0, 1, 31, 32, 127, 128, 512, 1025]) {
      assertEquals(
        matrix.rank(value, end),
        positions.filter((position) => position < end).length,
        `duplicate rank ${value}/${end}`,
      );
    }
    for (let occurrence = 0; occurrence < positions.length; occurrence++) {
      assertEquals(
        matrix.select(value, occurrence),
        positions[occurrence],
        `duplicate select ${value}/${occurrence}`,
      );
    }
    assertEquals(matrix.select(value, positions.length), -1, `missing select ${value}`);
  }
});

Deno.test("WaveletMatrixUint32 validates empty and invalid contracts", () => {
  using empty = WaveletMatrixUint32.from([]);
  assertEquals(empty.rank(0, 0), 0, "empty rank");
  assertEquals(empty.rangeFreq(0, 0, 0, 0x1_0000_0000), 0, "empty frequency");
  assertEquals(empty.predecessor(0, 0, 10), -1, "empty predecessor");

  let threw = false;
  try {
    empty.quantile(0, 0, 0);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "empty quantile rejects kth");

  const before = WaveletMatrixUint32.allocatorStats();
  threw = false;
  try {
    WaveletMatrixUint32.from([0, -1]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "invalid Uint32 input");
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "invalid construction allocations");
});

Deno.test("WaveletMatrixUint32 using lifecycle returns allocator storage", () => {
  const before = WaveletMatrixUint32.allocatorStats();
  {
    using matrix = WaveletMatrixUint32.from(
      Uint32Array.from({ length: 10_000 }, (_, index) => Math.imul(index, 2_654_435_761) >>> 0),
    );
    assertEquals(matrix.length, 10_000, "live wavelet matrix");
  }
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "wavelet allocations");
  assertEquals(after.liveBytes, before.liveBytes, "wavelet bytes");
});

Deno.test("WaveletMatrixUint32 allocator reaches a construction plateau", () => {
  const values = Uint32Array.from(
    { length: 1025 },
    (_, index) => Math.imul(index, 2_654_435_761) >>> 0,
  );
  for (let iteration = 0; iteration < 20; iteration++) {
    using matrix = WaveletMatrixUint32.from(values);
    matrix.rank(iteration, matrix.length);
  }
  const plateau = WaveletMatrixUint32.allocatorStats();
  for (let iteration = 0; iteration < 20; iteration++) {
    using matrix = WaveletMatrixUint32.from(values);
    matrix.quantile(0, matrix.length, iteration);
  }
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, plateau.liveAllocations, "plateau live allocations");
  assertEquals(after.liveBytes, plateau.liveBytes, "plateau live bytes");
  assertEquals(after.reservedBytes, plateau.reservedBytes, "plateau reserved bytes");
});
