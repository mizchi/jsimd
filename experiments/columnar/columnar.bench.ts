import { afterAll, bench, describe } from "vitest";
import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "../../src/columnar/mod.ts";

const LENGTH = 4_194_304;
const MINIMUM = 4_000_000;
const MAXIMUM = 5_000_000;
const CATEGORY = 3;
let sink = 0;

const numbers = Int32Array.from({ length: LENGTH }, (_, index) => {
  const page = index >>> 8;
  return page * 1_000 + (index & 255);
});
const categories = Uint8Array.from({ length: LENGTH }, (_, index) => index & 7);
const leftMask = new Uint32Array(Math.ceil(LENGTH / 32));
const rightMask = new Uint32Array(leftMask.length);

function fusedJsCount(): number {
  let count = 0;
  for (let index = 0; index < LENGTH; index++) {
    const value = numbers[index]!;
    if (value >= MINIMUM && value < MAXIMUM && categories[index] === CATEGORY) count++;
  }
  return count;
}

function materializedJsCount(): number {
  leftMask.fill(0);
  rightMask.fill(0);
  for (let index = 0; index < LENGTH; index++) {
    const value = numbers[index]!;
    if (value >= MINIMUM && value < MAXIMUM) leftMask[index >>> 5] |= 1 << (index & 31);
  }
  for (let index = 0; index < LENGTH; index++) {
    if (categories[index] === CATEGORY) rightMask[index >>> 5] |= 1 << (index & 31);
  }
  let count = 0;
  for (let index = 0; index < leftMask.length; index++) {
    let bits = (leftMask[index]! & rightMask[index]!) >>> 0;
    bits -= (bits >>> 1) & 0x5555_5555;
    bits = (bits & 0x3333_3333) + ((bits >>> 2) & 0x3333_3333);
    count += (((bits + (bits >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
  }
  return count;
}

describe("columnar shared selection mask over 4M rows", () => {
  const numberColumn = AdaptiveI32Column.from(numbers);
  const categoryColumn = BitSlicedU8Column.from(categories, 3);
  const output = new SelectionMask(LENGTH);
  const temporary = new SelectionMask(LENGTH);

  afterAll(() => {
    temporary[Symbol.dispose]();
    output[Symbol.dispose]();
    categoryColumn[Symbol.dispose]();
    numberColumn[Symbol.dispose]();
  });

  bench("columnar two predicates + and + count", () => {
    numberColumn.scanBetween(MINIMUM, MAXIMUM, output);
    categoryColumn.scanEq(CATEGORY, temporary);
    output.andAssign(temporary);
    sink ^= output.countOnes();
  });

  bench("fused Int32Array + Uint8Array count", () => {
    sink ^= fusedJsCount();
  });

  bench("materialized JS masks + and + count", () => {
    sink ^= materializedJsCount();
  });
});

const unsignedClustered = Uint32Array.from({ length: LENGTH }, (_, index) => {
  const page = index >>> 8;
  return (0x8000_0000 + page * 1_000 + (index & 255)) >>> 0;
});
const UNSIGNED_MINIMUM = 0x8040_0000;
const UNSIGNED_MAXIMUM = 0x8050_0000;
const unsignedMask = new Uint32Array(Math.ceil(LENGTH / 32));

function scalarUnsignedBetween(values: Uint32Array, minimum: number, maximum: number): number {
  unsignedMask.fill(0);
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (value < minimum || value >= maximum) continue;
    unsignedMask[index >>> 5] = (unsignedMask[index >>> 5]! | (1 << (index & 31))) >>> 0;
    count++;
  }
  return count;
}

describe("AdaptiveU32Column over 4M locally clustered high-bit values", () => {
  const column = AdaptiveU32Column.from(unsignedClustered);
  const output = new SelectionMask(LENGTH);
  afterAll(() => {
    output[Symbol.dispose]();
    column[Symbol.dispose]();
  });

  bench("adaptive u32 between + count", () => {
    sink ^= column.scanBetween(UNSIGNED_MINIMUM, UNSIGNED_MAXIMUM, output).countOnes();
  });
  bench("Uint32Array between + mask + count", () => {
    sink ^= scalarUnsignedBetween(unsignedClustered, UNSIGNED_MINIMUM, UNSIGNED_MAXIMUM);
  });
});

const unsignedRaw = Uint32Array.from(
  { length: LENGTH },
  (_, index) => (Math.imul(index, 0x9e37_79b1) ^ 0x8000_0000) >>> 0,
);
const RAW_MINIMUM = 0x4000_0000;
const RAW_MAXIMUM = 0xc000_0000;

describe("AdaptiveU32Column raw pages without ZoneMap pruning", () => {
  const column = AdaptiveU32Column.from(unsignedRaw);
  const output = new SelectionMask(LENGTH);
  afterAll(() => {
    output[Symbol.dispose]();
    column[Symbol.dispose]();
  });

  bench("adaptive raw u32 between + count", () => {
    sink ^= column.scanBetween(RAW_MINIMUM, RAW_MAXIMUM, output).countOnes();
  });
  bench("raw Uint32Array between + mask + count", () => {
    sink ^= scalarUnsignedBetween(unsignedRaw, RAW_MINIMUM, RAW_MAXIMUM);
  });
});
