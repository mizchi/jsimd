import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "../columnar/mod.ts";
import { assertEquals } from "../../test/assert.ts";

const I32_TEST_MIN = -0x8000_0000;
const I32_TEST_MAX = 0x7fff_ffff;

Deno.test("columnar predicates compose i32 and u8 columns in one resident mask", () => {
  const length = 777;
  const numbers = Int32Array.from({ length }, (_, index) => {
    const page = index >>> 8;
    return page * 1_000 + (index & 255);
  });
  const categories = Uint8Array.from({ length }, (_, index) => index & 7);
  const validity = Uint8Array.from({ length }, (_, index) => Number(index % 13 !== 0));
  using numberColumn = AdaptiveI32Column.from(numbers);
  using categoryColumn = BitSlicedU8Column.from(categories, 3, validity);
  using selection = new SelectionMask(length);
  using temporary = new SelectionMask(length);

  numberColumn.scanBetween(1_040, 2_090, selection);
  categoryColumn.scanEq(3, temporary);
  selection.andAssign(temporary);

  const expected: number[] = [];
  for (let index = 0; index < length; index++) {
    if (
      numbers[index]! >= 1_040 && numbers[index]! < 2_090 && categories[index] === 3 &&
      validity[index] !== 0
    ) expected.push(index);
  }
  const output = new Uint32Array(expected.length + 1).fill(0xffff_ffff);
  assertEquals(selection.positionsInto(output), expected.length, "composed position count");
  assertEquals(
    output.subarray(0, expected.length).join(","),
    expected.join(","),
    "composed positions",
  );
  assertEquals(output[expected.length], 0xffff_ffff, "position output tail");
});

Deno.test("SelectionMask provides complete reusable Boolean algebra", () => {
  using left = new SelectionMask(131);
  using right = new SelectionMask(131);
  left.fill();
  right.clear();
  assertEquals(left.countOnes(), 131, "filled count");
  assertEquals(right.countOnes(), 0, "cleared count");

  const values = Uint8Array.from({ length: 131 }, (_, index) => index & 3);
  using column = BitSlicedU8Column.from(values, 2);
  column.scanLt(2, right);
  left.andNotAssign(right);
  assertEquals(left.countOnes(), 65, "and-not count");
  left.invert();
  assertEquals(left.countOnes(), 66, "logical-tail invert");
  left.orAssign(right);
  assertEquals(left.countOnes(), 66, "or count");

  using equal = new SelectionMask(131);
  column.scanEq(3, equal);
  left.andAssign(equal);
  assertEquals(left.countOnes(), 0, "and count");
});

Deno.test("columnar shared allocator returns all storage after using", () => {
  const before = SelectionMask.allocatorStats();
  {
    const length = 65_536;
    using numbers = AdaptiveI32Column.from(
      Int32Array.from({ length }, (_, index) => (index >>> 8) * 100 + (index & 255)),
    );
    using categories = BitSlicedU8Column.from(
      Uint8Array.from({ length }, (_, index) => index & 15),
      4,
    );
    using output = new SelectionMask(length);
    numbers.scanLt(10_000, output);
    categories.scanEq(7, output);
  }
  const after = SelectionMask.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "columnar live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "columnar live bytes");
});

Deno.test("columnar predicates match scalar results across randomized tails", () => {
  let randomState = 0x6d2b_79f5;
  const random = (): number => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState;
  };
  for (const length of [0, 1, 3, 31, 32, 33, 127, 255, 256, 257, 511, 777]) {
    const numbers = Int32Array.from(
      { length },
      (_, index) => ((random() & 1) === 0 ? (random() & 0xffff) - 0x8000 : index * 100_003),
    );
    const categories = Uint8Array.from({ length }, () => random() & 15);
    const validity = Uint8Array.from({ length }, () => Number((random() & 7) !== 0));
    using numberColumn = AdaptiveI32Column.from(numbers);
    using categoryColumn = BitSlicedU8Column.from(categories, 4, validity);
    using actual = new SelectionMask(length);
    using temporary = new SelectionMask(length);

    for (
      const [minimum, maximum] of [
        [-20_000, 20_000],
        [0, 0],
        [I32_TEST_MIN, I32_TEST_MAX],
        [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ] as const
    ) {
      numberColumn.scanBetween(minimum, maximum, actual);
      const expected: number[] = [];
      for (let index = 0; index < length; index++) {
        if (numbers[index]! >= minimum && numbers[index]! < maximum) expected.push(index);
      }
      assertEquals(
        actual.toIndices().join(","),
        expected.join(","),
        `i32 between length ${length}`,
      );
    }

    numberColumn.scanLt(Number.MAX_SAFE_INTEGER, actual);
    assertEquals(actual.countOnes(), length, `wide i32 lt length ${length}`);
    numberColumn.scanEq(Number.MAX_SAFE_INTEGER, actual);
    assertEquals(actual.countOnes(), 0, `wide i32 eq length ${length}`);

    numberColumn.scanLt(12_345, actual);
    categoryColumn.scanBetween(3, 11, temporary);
    actual.andAssign(temporary);
    const expected: number[] = [];
    for (let index = 0; index < length; index++) {
      if (
        numbers[index]! < 12_345 && categories[index]! >= 3 && categories[index]! < 11 &&
        validity[index] !== 0
      ) expected.push(index);
    }
    assertEquals(actual.toIndices().join(","), expected.join(","), `composed length ${length}`);

    for (const index of [0, Math.max(0, length - 1)]) {
      if (length > 0) {
        assertEquals(numberColumn.get(index), numbers[index], `i32 get length ${length}`);
        assertEquals(
          categoryColumn.get(index),
          validity[index] === 0 ? undefined : categories[index],
          `u8 get length ${length}`,
        );
      }
    }
  }
});

Deno.test("columnar rejects incompatible masks, small outputs, and use after using", () => {
  using column = AdaptiveI32Column.from(Int32Array.of(1, 2, 3));
  using wrong = new SelectionMask(2);
  let incompatibleThrew = false;
  try {
    column.scanEq(1, wrong);
  } catch (error) {
    incompatibleThrew = error instanceof RangeError;
  }
  assertEquals(incompatibleThrew, true, "incompatible mask rejected");

  using mask = new SelectionMask(3);
  mask.fill();
  let outputThrew = false;
  try {
    mask.positionsInto(new Uint32Array(2));
  } catch (error) {
    outputThrew = error instanceof RangeError;
  }
  assertEquals(outputThrew, true, "undersized output rejected");

  const disposed = new SelectionMask(3);
  disposed[Symbol.dispose]();
  let disposedThrew = false;
  try {
    disposed.countOnes();
  } catch (error) {
    disposedThrew = error instanceof Error;
  }
  assertEquals(disposedThrew, true, "disposed mask rejected");
});

Deno.test("AdaptiveU32Column preserves unsigned ordering across the sign boundary", () => {
  const values = new Uint32Array(768);
  values.fill(0xffff_ff00, 0, 256);
  for (let index = 256; index < 512; index++) values[index] = 0xffff_0000 + (index & 255);
  for (let index = 512; index < 768; index++) {
    values[index] = index & 1 ? index : (0x8000_0000 + index) >>> 0;
  }

  using column = AdaptiveU32Column.from(values);
  using selected = new SelectionMask(values.length);
  assertEquals(column.min, 513, "u32 minimum");
  assertEquals(column.max, 0xffff_ff00, "u32 maximum");
  assertEquals(column.get(0), 0xffff_ff00, "constant get");
  assertEquals(column.get(300), values[300], "FOR get");
  assertEquals(column.get(700), values[700], "raw get");
  assertEquals(
    JSON.stringify(column.encodingCounts()),
    JSON.stringify({ constant: 1, frameOfReference: 1, raw: 1 }),
    "u32 encoding counts",
  );

  column.scanLt(0x8000_0000, selected);
  assertEquals(selected.countOnes(), 128, "unsigned less-than count");
  column.scanBetween(0xffff_0000, 0xffff_ff01, selected);
  assertEquals(selected.countOnes(), 512, "unsigned range count");
  column.scanEq(0xffff_ff00, selected);
  assertEquals(selected.countOnes(), 256, "unsigned equality count");
});

Deno.test("AdaptiveU32Column matches scalar predicates and releases using-owned pages", () => {
  const before = AdaptiveU32Column.allocatorStats();
  {
    const values = Uint32Array.from(
      { length: 1_037 },
      (_, index) => (Math.imul(index, 0x9e37_79b1) ^ 0x8000_0000) >>> 0,
    );
    using column = AdaptiveU32Column.from(values);
    using selected = new SelectionMask(values.length);
    for (
      const [minimum, maximum] of [
        [0, 1],
        [0x7fff_ff00, 0x8000_0100],
        [0xf000_0000, 0x1_0000_0000],
      ] as const
    ) {
      column.scanBetween(minimum, maximum, selected);
      let expected = 0;
      for (const value of values) expected += Number(value >= minimum && value < maximum);
      assertEquals(selected.countOnes(), expected, `u32 range ${minimum}:${maximum}`);
    }
  }
  const after = AdaptiveU32Column.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "u32 live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "u32 live bytes");

  for (const invalid of [-1, 0x1_0000_0000, 1.5]) {
    let threw = false;
    try {
      AdaptiveU32Column.from([invalid]);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assertEquals(threw, true, `invalid u32 ${invalid}`);
  }

  const disposed = AdaptiveU32Column.from(Uint32Array.of(1, 2, 3));
  disposed[Symbol.dispose]();
  let disposedThrew = false;
  try {
    disposed.get(0);
  } catch (error) {
    disposedThrew = error instanceof Error;
  }
  assertEquals(disposedThrew, true, "u32 use after dispose");
});
