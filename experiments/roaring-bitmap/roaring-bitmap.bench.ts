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

type SetOperation = "or" | "xor" | "andNot";

function sortedSetOperationInto(
  left: Uint32Array,
  right: Uint32Array,
  output: Uint32Array,
  operation: SetOperation,
): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const a = leftIndex < left.length ? left[leftIndex]! : 0x1_0000_0000;
    const b = rightIndex < right.length ? right[rightIndex]! : 0x1_0000_0000;
    if (a === b) {
      if (operation === "or") output[count++] = a;
      leftIndex++;
      rightIndex++;
    } else if (a < b) {
      output[count++] = a;
      leftIndex++;
    } else {
      if (operation !== "andNot") output[count++] = b;
      rightIndex++;
    }
  }
  return count;
}

function setOperationInto(
  left: Set<number>,
  right: Set<number>,
  output: Set<number>,
  operation: SetOperation,
): void {
  output.clear();
  if (operation === "andNot") {
    for (const value of left) if (!right.has(value)) output.add(value);
    return;
  }
  for (const value of left) {
    if (operation === "or" || !right.has(value)) output.add(value);
  }
  for (const value of right) {
    if (operation === "or" || !left.has(value)) output.add(value);
  }
}

function setHasMany(values: Set<number>, queries: Uint32Array, output: Uint8Array): void {
  for (let index = 0; index < queries.length; index++) {
    output[index] = values.has(queries[index]!) ? 1 : 0;
  }
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
  const sortedOutput = new Uint32Array(leftValues.length + rightValues.length);
  const membershipOutput = new Uint8Array(rightValues.length);
  const leftSet = new Set(leftValues);
  const rightSet = new Set(rightValues);
  const setOutput = new Set<number>();

  afterAll(() => {
    roaringOutput[Symbol.dispose]();
    roaringRight[Symbol.dispose]();
    roaringLeft[Symbol.dispose]();
  });

  bench("Roaring construction", () => {
    using value = RoaringBitmap.from(leftValues);
    sink ^= value.size;
  });
  bench("sorted Uint32Array copy", () => {
    const value = new Uint32Array(leftValues);
    sink ^= value.length;
  });
  bench("Set<number> construction", () => {
    const value = new Set(leftValues);
    sink ^= value.size;
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

  for (const operation of ["or", "xor", "andNot"] as const) {
    bench(`Roaring ${operation}Cardinality`, () => {
      sink ^= roaringLeft[`${operation}Cardinality`](roaringRight);
    });
    bench(`Roaring ${operation}Into`, () => {
      roaringLeft[`${operation}Into`](roaringRight, roaringOutput);
      sink ^= roaringOutput.size;
    });
    bench(`sorted Uint32Array ${operation} into`, () => {
      sink ^= sortedSetOperationInto(leftValues, rightValues, sortedOutput, operation);
    });
    bench(`Set<number> ${operation} into`, () => {
      setOperationInto(leftSet, rightSet, setOutput, operation);
      sink ^= setOutput.size;
    });
  }
  bench("Roaring hasMany", () => {
    roaringLeft.hasMany(rightValues, membershipOutput);
    sink ^= membershipOutput[0]!;
  });
  bench("Set<number> has many", () => {
    setHasMany(leftSet, rightValues, membershipOutput);
    sink ^= membershipOutput[0]!;
  });
});
