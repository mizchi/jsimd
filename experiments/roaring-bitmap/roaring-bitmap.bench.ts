import { afterAll, bench, describe } from "vitest";
import { RoaringBitmap } from "../../src/roaring-bitmap/mod.ts";

let sink = 0;

function sortedIntersectionCount(left: Uint32Array, right: Uint32Array): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a < b) leftIndex++;
    else if (a > b) rightIndex++;
    else {
      count++;
      leftIndex++;
      rightIndex++;
    }
  }
  return count;
}

function sortedIntersectionInto(
  left: Uint32Array,
  right: Uint32Array,
  output: Uint32Array,
): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a < b) leftIndex++;
    else if (a > b) rightIndex++;
    else {
      output[count++] = a;
      leftIndex++;
      rightIndex++;
    }
  }
  return count;
}

function setIntersectionCount(left: Set<number>, right: Set<number>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  for (const value of small) if (large.has(value)) count++;
  return count;
}

function setIntersectionInto(
  left: Set<number>,
  right: Set<number>,
  output: Set<number>,
): void {
  output.clear();
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) output.add(value);
}

function denseValues(divisor: number): Uint32Array {
  const output: number[] = [];
  for (let high = 0; high < 16; high++) {
    const base = high * 65_536;
    for (let low = 0; low < 65_536; low += divisor) output.push(base + low);
  }
  return Uint32Array.from(output);
}

function sparseValues(multiplier: number): Uint32Array {
  const output = new Uint32Array(1_024 * 32);
  let index = 0;
  for (let high = 0; high < 1_024; high++) {
    const base = high * 65_536;
    for (let item = 0; item < 32; item++) output[index++] = base + item * multiplier;
  }
  return output;
}

describe.each(
  [
    ["dense bitmap containers", denseValues(7), denseValues(11)],
    ["many sparse array containers", sparseValues(2), sparseValues(3)],
  ] as const,
)("RoaringBitmap %s", (_name, leftValues, rightValues) => {
  const roaringLeft = RoaringBitmap.from(leftValues);
  const roaringRight = RoaringBitmap.from(rightValues);
  const roaringOutput = new RoaringBitmap();
  const sortedOutput = new Uint32Array(Math.min(leftValues.length, rightValues.length));
  const leftSet = new Set(leftValues);
  const rightSet = new Set(rightValues);
  const setOutput = new Set<number>();

  afterAll(() => {
    roaringOutput[Symbol.dispose]();
    roaringRight[Symbol.dispose]();
    roaringLeft[Symbol.dispose]();
  });

  bench("Roaring andCardinality", () => {
    sink ^= roaringLeft.andCardinality(roaringRight);
  });
  bench("sorted Uint32Array intersection count", () => {
    sink ^= sortedIntersectionCount(leftValues, rightValues);
  });
  bench("Set<number> intersection count", () => {
    sink ^= setIntersectionCount(leftSet, rightSet);
  });
  bench("Roaring andInto", () => {
    roaringLeft.andInto(roaringRight, roaringOutput);
    sink ^= roaringOutput.size;
  });
  bench("sorted Uint32Array intersection into", () => {
    sink ^= sortedIntersectionInto(leftValues, rightValues, sortedOutput);
  });
  bench("Set<number> intersection into", () => {
    setIntersectionInto(leftSet, rightSet, setOutput);
    sink ^= setOutput.size;
  });
});
