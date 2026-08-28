import {
  AdaptivePageEncoding,
  AdaptiveSimdColumnI32,
  AdaptiveSimdPageI32,
  SimdColumnMask,
  SimdPageMask,
} from "../adaptive-simd-page-i32/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("AdaptiveSimdPageI32 selects a physical encoding per page", () => {
  using constant = AdaptiveSimdPageI32.from([7, 7, 7]);
  using narrow = AdaptiveSimdPageI32.from([-100, -99, -50, -75]);
  using wide = AdaptiveSimdPageI32.from([-0x8000_0000, 0, 0x7fff_ffff]);
  assertEquals(constant.encoding, AdaptivePageEncoding.Constant, "constant encoding");
  assertEquals(constant.encodedBytes, 0, "constant payload");
  assertEquals(narrow.encoding, AdaptivePageEncoding.FrameOfReference, "FOR encoding");
  assertEquals(narrow.bitWidth, 6, "FOR width");
  assertEquals(wide.encoding, AdaptivePageEncoding.Raw, "raw encoding");
});

Deno.test("AdaptiveSimdPageI32 selects and queries run-length pages", () => {
  const values = Int32Array.from({ length: 128 }, (_, index) => {
    if (index < 32) return -0x8000_0000;
    if (index < 64) return 7;
    if (index < 96) return 1_000_000;
    return 0x7fff_ffff;
  });
  using page = AdaptiveSimdPageI32.from(values);
  using mask = new SimdPageMask(values.length);
  assertEquals(page.encoding, AdaptivePageEncoding.RunLength, "RLE encoding");
  assertEquals(page.encodedBytes, 32, "four value/end pairs");
  assertEquals(page.toInt32Array().join(","), values.join(","), "RLE decode");
  assertEquals(page.get(31), -0x8000_0000, "RLE get before boundary");
  assertEquals(page.get(32), 7, "RLE get after boundary");
  assertEquals(
    page.sum(),
    values.reduce((sum, value) => sum + value, 0),
    "RLE sum",
  );
  assertEquals(page.scanEq(7, mask).countOnes(), 32, "RLE eq");
  assertEquals(page.scanLt(8, mask).countOnes(), 64, "RLE lt");
  assertEquals(page.scanBetween(0, 2_000_000, mask).countOnes(), 64, "RLE between");
  const gathered = new Int32Array(mask.countOnes());
  assertEquals(page.gatherInto(mask, gathered), 64, "RLE gather count");
  assertEquals(gathered[0], 7, "RLE gather first run");
  assertEquals(gathered[63], 1_000_000, "RLE gather last run");
});

Deno.test("AdaptiveSimdPageI32 selects and queries dictionary pages", () => {
  const dictionary = [-0x8000_0000, 7, 1_000_000, 0x7fff_ffff];
  const values = Int32Array.from(
    { length: 256 },
    (_, index) => dictionary[Math.imul(index, 5) & 3]!,
  );
  using page = AdaptiveSimdPageI32.from(values);
  using mask = new SimdPageMask(values.length);
  assertEquals(page.encoding, AdaptivePageEncoding.Dictionary, "Dictionary encoding");
  assertEquals(page.encodedBytes, 288, "four value/count pairs and byte codes");
  assertEquals(page.toInt32Array().join(","), values.join(","), "Dictionary decode");
  assertEquals(page.get(0), -0x8000_0000, "Dictionary get first");
  assertEquals(page.get(3), 0x7fff_ffff, "Dictionary get fourth");
  assertEquals(
    page.sum(),
    values.reduce((sum, value) => sum + value, 0),
    "Dictionary sum",
  );
  assertEquals(page.scanEq(1_000_000, mask).countOnes(), 64, "Dictionary eq");
  assertEquals(page.scanLt(8, mask).countOnes(), 128, "Dictionary lt");
  assertEquals(page.scanBetween(0, 2_000_000, mask).countOnes(), 128, "Dictionary between");
  const gathered = new Int32Array(mask.countOnes());
  assertEquals(page.gatherInto(mask, gathered), 128, "Dictionary gather count");
  assertEquals(gathered[0], 7, "Dictionary gather first code");
  assertEquals(gathered[127], 1_000_000, "Dictionary gather last code");
});

Deno.test("AdaptiveSimdPageI32 dictionary SIMD masks match scalar tails", () => {
  const dictionary = [-0x8000_0000, -7, 1_000_000, 0x7fff_ffff];
  for (const length of [17, 31, 32, 33, 127, 129, 255]) {
    const values = Int32Array.from(
      { length },
      (_, index) => dictionary[(Math.imul(index, 13) ^ (index >>> 2)) & 3]!,
    );
    using page = AdaptiveSimdPageI32.from(values);
    using mask = new SimdPageMask(length);
    assertEquals(page.encoding, AdaptivePageEncoding.Dictionary, `encoding n=${length}`);
    for (
      const [minimum, maximum] of [
        [-0x8000_0000, -6],
        [-7, 2_000_000],
        [0, 0x8000_0000],
      ]
    ) {
      const expected = Array.from(values.keys()).filter((index) =>
        values[index]! >= minimum && values[index]! < maximum
      );
      assertEquals(
        page.scanBetween(minimum, maximum, mask).toIndices().join(","),
        expected.join(","),
        `between n=${length}`,
      );
    }
  }
});

Deno.test("AdaptiveSimdPageI32 selects and queries sparse-default pages", () => {
  const values = Int32Array.from(
    { length: 256 },
    (_, index) => (index & 7) === 0 ? Math.imul(index + 1, 0x6d2b_79f5) | 0 : -7,
  );
  using page = AdaptiveSimdPageI32.from(values);
  using mask = new SimdPageMask(values.length);
  assertEquals(page.encoding, AdaptivePageEncoding.Sparse, "Sparse encoding");
  assertEquals(page.encodedBytes, 160, "32 positions and 32 i32 exceptions");
  assertEquals(page.toInt32Array().join(","), values.join(","), "Sparse decode");
  assertEquals(page.get(1), -7, "Sparse default get");
  assertEquals(page.get(8), values[8], "Sparse exception get");
  assertEquals(page.sum(), values.reduce((sum, value) => sum + value, 0), "Sparse sum");
  for (
    const [minimum, maximum] of [
      [-7, -6],
      [-0x8000_0000, 0],
      [0, 0x8000_0000],
    ]
  ) {
    const expected = Array.from(values.keys()).filter((index) =>
      values[index]! >= minimum && values[index]! < maximum
    );
    assertEquals(
      page.scanBetween(minimum, maximum, mask).toIndices().join(","),
      expected.join(","),
      `Sparse between ${minimum}`,
    );
  }
  const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === -7);
  assertEquals(
    page.scanEq(-7, mask).toIndices().join(","),
    expectedEqual.join(","),
    "Sparse eq default",
  );
  const gathered = new Int32Array(mask.countOnes());
  assertEquals(page.gatherInto(mask, gathered), expectedEqual.length, "Sparse gather count");
  assertEquals(gathered.every((value) => value === -7), true, "Sparse gathered defaults");
});

Deno.test("AdaptiveSimdPageI32 sparse masks match scalar tails", () => {
  for (const length of [17, 31, 32, 33, 127, 129, 255]) {
    const values = Int32Array.from(
      { length },
      (_, index) => (index & 7) === 0 ? Math.imul(index + 1, 0x6d2b_79f5) | 0 : -7,
    );
    using page = AdaptiveSimdPageI32.from(values);
    using mask = new SimdPageMask(length);
    assertEquals(page.encoding, AdaptivePageEncoding.Sparse, `encoding n=${length}`);
    const target = values[0]!;
    const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === target);
    assertEquals(
      page.scanEq(target, mask).toIndices().join(","),
      expectedEqual.join(","),
      `equal n=${length}`,
    );
    const expectedLess = Array.from(values.keys()).filter((index) => values[index]! < 0);
    assertEquals(
      page.scanLt(0, mask).toIndices().join(","),
      expectedLess.join(","),
      `less n=${length}`,
    );
  }
});

Deno.test("AdaptiveSimdPageI32 decodes, indexes, and reduces every encoding", () => {
  const cases = [
    [11, 11, 11, 11, 11],
    [-1000, -999, -750, -500, -989],
    [-0x8000_0000, 17, 0x7fff_ffff, -19, 1_000_000],
  ];
  for (const values of cases) {
    using page = AdaptiveSimdPageI32.from(values);
    const decoded = new Int32Array(values.length);
    assertEquals(page.decodeInto(decoded), values.length, "decoded count");
    assertEquals(decoded.join(","), values.join(","), `decode ${page.encoding}`);
    assertEquals(page.sum(), values.reduce((sum, value) => sum + value, 0), "sum");
    for (let index = 0; index < values.length; index++) {
      assertEquals(page.get(index), values[index], `get ${index}`);
    }
  }
});

Deno.test("AdaptiveSimdPageI32 scans into composable masks and gathers", () => {
  const values = [-3, 1, 4, 1, 5, 9, 2, 6];
  using page = AdaptiveSimdPageI32.from(values);
  using equal = new SimdPageMask(values.length);
  using less = new SimdPageMask(values.length);
  using range = new SimdPageMask(values.length);
  assertEquals(page.scanEq(1, equal).toIndices().join(","), "1,3", "equal");
  assertEquals(page.scanLt(4, less).toIndices().join(","), "0,1,3,6", "less");
  assertEquals(
    page.scanBetween(1, 6, range).toIndices().join(","),
    "1,2,3,4,6",
    "between",
  );
  equal.orAssign(less).differenceAssign(range);
  assertEquals(equal.toIndices().join(","), "0", "mask composition");

  page.scanBetween(1, 6, range);
  const gathered = new Int32Array(range.countOnes());
  assertEquals(page.gatherInto(range, gathered), 5, "gathered count");
  assertEquals(gathered.join(","), "1,4,1,5,2", "gathered values");
});

Deno.test("AdaptiveSimdPageI32 matches scalar predicates across SIMD tails", () => {
  let state = 0x6d2b_79f5;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    return state;
  };
  for (const length of [0, 1, 3, 4, 5, 31, 32, 33, 127, 128, 129, 255, 256]) {
    for (const narrow of [true, false]) {
      const values = Int32Array.from(
        { length },
        narrow ? () => -10_000 + (next() & 1023) : () => next(),
      );
      using page = AdaptiveSimdPageI32.from(values);
      using mask = new SimdPageMask(length);
      const decoded = new Int32Array(length);
      page.decodeInto(decoded);
      assertEquals(decoded.join(","), values.join(","), `decode n=${length}, narrow=${narrow}`);
      const target = values[length >>> 1] ?? 0;
      const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === target);
      assertEquals(
        page.scanEq(target, mask).toIndices().join(","),
        expectedEqual.join(","),
        `equal n=${length}, narrow=${narrow}`,
      );
      const expectedLess = Array.from(values.keys()).filter((index) => values[index]! < target);
      assertEquals(
        page.scanLt(target, mask).toIndices().join(","),
        expectedLess.join(","),
        `less n=${length}, narrow=${narrow}`,
      );
      for (
        const [minimum, maximum] of [
          [-10_000, -9_500],
          [-1, 1],
          [-0x8000_0000, 0x8000_0000],
        ]
      ) {
        const expected = Array.from(values.keys()).filter((index) =>
          values[index]! >= minimum && values[index]! < maximum
        );
        assertEquals(
          page.scanBetween(minimum, maximum, mask).toIndices().join(","),
          expected.join(","),
          `between n=${length}, narrow=${narrow}`,
        );
      }
    }
  }
});

Deno.test("AdaptiveSimdPageI32 validates page and mask contracts", () => {
  let threw = false;
  try {
    AdaptiveSimdPageI32.from(new Int32Array(257));
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "page length");
  threw = false;
  try {
    AdaptiveSimdPageI32.from([1.5]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "i32 values");

  using page = AdaptiveSimdPageI32.from([1, 2, 3]);
  using wrongMask = new SimdPageMask(2);
  threw = false;
  try {
    page.scanEq(1, wrongMask);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "mask length");
});

Deno.test("AdaptiveSimdPageI32 snapshots Int32Array input", () => {
  const values = new Int32Array([-0x8000_0000, 17, 0x7fff_ffff]);
  using page = AdaptiveSimdPageI32.from(values);
  values.fill(0);
  assertEquals(
    page.toInt32Array().join(","),
    "-2147483648,17,2147483647",
    "snapshot",
  );
});

Deno.test("AdaptiveSimdPageI32 using lifecycle returns allocator storage", () => {
  const before = AdaptiveSimdPageI32.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    using page = AdaptiveSimdPageI32.from(Int32Array.from({ length: 256 }, (_, i) => i));
    using mask = new SimdPageMask(page.length);
    assertEquals(page.scanLt(128, mask).countOnes(), 128, "live page");
  }
  const after = AdaptiveSimdPageI32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
  if (after.reservedBytes > before.reservedBytes + 512) {
    throw new Error(
      `adaptive page storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
});

Deno.test("AdaptiveSimdColumnI32 partitions values into independently encoded pages", () => {
  const values = Int32Array.from({ length: 856 }, (_, index) => {
    if (index < 256) return 7;
    if (index < 512) return -1000 + (index & 63);
    if (index < 768) return index % 2 === 0 ? -0x8000_0000 : 0x7fff_ffff;
    return Math.imul(index + 1, 0x6d2b_79f5) | 0;
  });
  using column = AdaptiveSimdColumnI32.from(values);
  assertEquals(column.length, 856, "length");
  assertEquals(column.pageSize, 256, "page size");
  assertEquals(column.pageCount, 4, "page count");
  assertEquals(column.get(255), 7, "get before boundary");
  assertEquals(column.get(256), -1000, "get after boundary");
  assertEquals(column.min, -0x8000_0000, "minimum");
  assertEquals(column.max, 0x7fff_ffff, "maximum");
  assertEquals(column.toInt32Array().join(","), values.join(","), "decode");
  assertEquals(
    column.sum(),
    values.reduce((sum, value) => sum + value, 0),
    "sum",
  );
  const encodings = column.encodingCounts();
  assertEquals(encodings.constant, 1, "constant pages");
  assertEquals(encodings.dictionary, 1, "Dictionary pages");
  assertEquals(encodings.frameOfReference, 1, "FOR pages");
  assertEquals(encodings.runLength, 0, "RLE pages");
  assertEquals(encodings.sparse, 0, "Sparse pages");
  assertEquals(encodings.raw, 1, "raw pages");
});

Deno.test("AdaptiveSimdColumnI32 reports run-length pages", () => {
  const values = Int32Array.from(
    { length: 128 },
    (_, index) => index < 32 ? -0x8000_0000 : index < 96 ? 1_000_000 : 0x7fff_ffff,
  );
  using column = AdaptiveSimdColumnI32.from(values, 128);
  assertEquals(column.encodingCounts().runLength, 1, "RLE pages");
});

Deno.test("AdaptiveSimdColumnI32 scans, composes masks, and gathers across pages", () => {
  const values = Int32Array.from({ length: 777 }, (_, index) => (index * 17 % 101) - 50);
  using column = AdaptiveSimdColumnI32.from(values, 129);
  using equal = new SimdColumnMask(values.length, 129);
  using less = new SimdColumnMask(values.length, 129);
  using range = new SimdColumnMask(values.length, 129);

  const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === 7);
  assertEquals(column.scanEq(7, equal).toIndices().join(","), expectedEqual.join(","), "equal");
  const expectedLess = Array.from(values.keys()).filter((index) => values[index]! < -13);
  assertEquals(column.scanLt(-13, less).toIndices().join(","), expectedLess.join(","), "less");
  const expectedRange = Array.from(values.keys()).filter((index) =>
    values[index]! >= -5 && values[index]! < 19
  );
  assertEquals(
    column.scanBetween(-5, 19, range).toIndices().join(","),
    expectedRange.join(","),
    "between",
  );

  equal.orAssign(less).differenceAssign(range);
  const expectedComposed = Array.from(values.keys()).filter((index) =>
    (values[index] === 7 || values[index]! < -13) &&
    !(values[index]! >= -5 && values[index]! < 19)
  );
  assertEquals(equal.toIndices().join(","), expectedComposed.join(","), "composition");

  column.scanBetween(-5, 19, range);
  const gathered = new Int32Array(range.countOnes());
  assertEquals(column.gatherInto(range, gathered), expectedRange.length, "gather count");
  assertEquals(
    gathered.join(","),
    expectedRange.map((index) => values[index]).join(","),
    "gather values",
  );
});

Deno.test("AdaptiveSimdColumnI32 matches scalar predicates across page tails", () => {
  let state = 0x85eb_ca6b;
  for (const length of [0, 1, 128, 129, 130, 255, 256, 257, 513, 1025]) {
    const values = Int32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      return state;
    });
    using column = AdaptiveSimdColumnI32.from(values, 129);
    using mask = new SimdColumnMask(length, 129);
    const target = values[length >>> 1] ?? 0;
    const expected = Array.from(values.keys()).filter((index) => values[index]! < target);
    assertEquals(
      column.scanLt(target, mask).toIndices().join(","),
      expected.join(","),
      `length=${length}`,
    );
  }
});

Deno.test("AdaptiveSimdColumnI32 using lifecycle releases every page and mask", () => {
  const before = AdaptiveSimdPageI32.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using column = AdaptiveSimdColumnI32.from(
      Int32Array.from({ length: 1025 }, (_, index) => index - 512),
      129,
    );
    using mask = new SimdColumnMask(column.length, column.pageSize);
    assertEquals(column.scanLt(0, mask).countOnes(), 512, "live column");
  }
  const after = AdaptiveSimdPageI32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
