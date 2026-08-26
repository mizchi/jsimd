import { afterAll, bench, describe } from "vitest";
import {
  AdaptiveSimdColumnI32,
  AdaptiveSimdPageI32,
  SimdColumnMask,
  SimdPageMask,
} from "../../src/adaptive-simd-page-i32/mod.ts";

let sink = 0;

function scalarBetween(
  values: Int32Array,
  minimum: number,
  maximum: number,
  output: Uint32Array,
): number {
  output.fill(0);
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum || value >= maximum) continue;
    output[index >>> 5] = (output[index >>> 5]! | (1 << (index & 31))) >>> 0;
    count++;
  }
  return count;
}

function scalarSum(values: Int32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

const cases = [
  ["constant", new Int32Array(256).fill(7), 7, 8],
  [
    "narrow FOR",
    Int32Array.from(
      { length: 256 },
      (_, index) => -10_000 + ((Math.imul(index, 17) ^ (index >>> 3)) & 1023),
    ),
    -9_800,
    -9_200,
  ],
  [
    "wide raw",
    Int32Array.from({ length: 256 }, (_, index) => Math.imul(index + 1, 0x6d2b_79f5) | 0),
    -500_000_000,
    500_000_000,
  ],
] as const;

describe.each(cases)("AdaptiveSimdPageI32 %s", (_name, values, minimum, maximum) => {
  const page = AdaptiveSimdPageI32.from(values);
  const selection = new SimdPageMask(values.length);
  const scalarMask = new Uint32Array(Math.ceil(values.length / 32));
  const decoded = new Int32Array(values.length);

  afterAll(() => {
    selection[Symbol.dispose]();
    page[Symbol.dispose]();
  });

  bench("adaptive between + count", () => {
    page.scanBetween(minimum, maximum, selection);
    sink ^= selection.countOnes();
  });
  bench("Int32Array between + mask + count", () => {
    sink ^= scalarBetween(values, minimum, maximum, scalarMask);
  });
  bench("adaptive sum", () => {
    sink ^= page.sum();
  });
  bench("Int32Array scalar sum", () => {
    sink ^= scalarSum(values);
  });
  bench("adaptive decodeInto", () => {
    sink ^= page.decodeInto(decoded);
  });
  bench("Int32Array copy", () => {
    decoded.set(values);
    sink ^= decoded.length;
  });
});

const columnValues = Int32Array.from({ length: 65_536 }, (_, index) => {
  const page = index >>> 8;
  return page % 4 === 0 ? page : page * 1000 + (index & 255);
});
describe("AdaptiveSimdColumnI32 65K locally clustered values", () => {
  const column = AdaptiveSimdColumnI32.from(columnValues);
  const selection = new SimdColumnMask(column.length);
  const scalarMask = new Uint32Array(Math.ceil(column.length / 32));
  afterAll(() => {
    selection[Symbol.dispose]();
    column[Symbol.dispose]();
  });
  bench("adaptive column between + count", () => {
    sink ^= column.scanBetween(100_000, 120_000, selection).countOnes();
  });
  bench("Int32Array between + mask + count", () => {
    sink ^= scalarBetween(columnValues, 100_000, 120_000, scalarMask);
  });
  bench("adaptive column sum", () => {
    sink ^= column.sum();
  });
  bench("Int32Array scalar sum", () => {
    sink ^= scalarSum(columnValues);
  });
});
