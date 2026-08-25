import { afterAll, bench, describe } from "vitest";
import { BitSlicedColumnU8, BitSliceMask } from "../../src/bit-sliced-column/mod.ts";

const LENGTH = 4_194_304;
let sink = 0;

const values = Uint8Array.from(
  { length: LENGTH },
  (_, index) => (Math.imul(index, 17) ^ (index >>> 7)) & 31,
);
const categories = Uint8Array.from({ length: LENGTH }, (_, index) => index & 3);
const scalarMask = new Uint32Array(LENGTH >>> 5);

function resetScalarMask(): void {
  scalarMask.fill(0);
}

function scalarEq(target: number): number {
  resetScalarMask();
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== target) continue;
    scalarMask[index >>> 5] |= 1 << (index & 31);
    count++;
  }
  return count;
}

function scalarLt(target: number): number {
  resetScalarMask();
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    if (values[index]! >= target) continue;
    scalarMask[index >>> 5] |= 1 << (index & 31);
    count++;
  }
  return count;
}

function scalarBetween(minimum: number, maximum: number): number {
  resetScalarMask();
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum || value > maximum) continue;
    scalarMask[index >>> 5] |= 1 << (index & 31);
    count++;
  }
  return count;
}

function scalarComposed(minimum: number, maximum: number, category: number): number {
  resetScalarMask();
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum || value > maximum || categories[index] !== category) continue;
    scalarMask[index >>> 5] |= 1 << (index & 31);
    count++;
  }
  return count;
}

describe("BitSlicedColumnU8 predicate scans", () => {
  const column = BitSlicedColumnU8.from(values, 5);
  const category = BitSlicedColumnU8.from(categories, 2);
  const output = new BitSliceMask(LENGTH);
  const temporary = new BitSliceMask(LENGTH);

  afterAll(() => {
    temporary[Symbol.dispose]();
    output[Symbol.dispose]();
    category[Symbol.dispose]();
    column[Symbol.dispose]();
  });

  bench("BitSliced eq + count", () => {
    column.eq(17, output);
    sink ^= output.countOnes();
  });
  bench("Uint8Array eq + mask + count", () => {
    sink ^= scalarEq(17);
  });
  bench("BitSliced lt + count", () => {
    column.lt(17, output);
    sink ^= output.countOnes();
  });
  bench("Uint8Array lt + mask + count", () => {
    sink ^= scalarLt(17);
  });
  bench("BitSliced between + count", () => {
    column.between(7, 23, output);
    sink ^= output.countOnes();
  });
  bench("Uint8Array between + mask + count", () => {
    sink ^= scalarBetween(7, 23);
  });
  bench("BitSliced composed predicates + count", () => {
    column.between(7, 23, output);
    category.eq(2, temporary);
    output.andAssign(temporary);
    sink ^= output.countOnes();
  });
  bench("Uint8Array composed scan + mask + count", () => {
    sink ^= scalarComposed(7, 23, 2);
  });
});
