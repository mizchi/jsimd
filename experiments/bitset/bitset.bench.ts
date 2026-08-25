import { bench, describe } from "vitest";
import { FixedBitSet } from "../../bitset.ts";

function popcount(word: number): number {
  word -= (word >>> 1) & 0x5555_5555;
  word = (word & 0x3333_3333) + ((word >>> 2) & 0x3333_3333);
  return (((word + (word >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

function scalarIntersectionCount(left: Uint32Array, right: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < left.length; index++) {
    count += popcount(left[index]! & right[index]!);
  }
  return count;
}

function scalarUnionInto(left: Uint32Array, right: Uint32Array): void {
  for (let index = 0; index < left.length; index++) left[index] = left[index]! | right[index]!;
}

describe.each([16_384, 262_144, 4_194_304])("FixedBitSet capacity=%i", (capacity) => {
  const leftBits: number[] = [];
  const rightBits: number[] = [];
  const leftWords = new Uint32Array(Math.ceil(capacity / 32));
  const rightWords = new Uint32Array(leftWords.length);
  for (let bit = 0; bit < capacity; bit++) {
    if (bit % 7 === 0) {
      leftBits.push(bit);
      leftWords[bit >>> 5] |= 1 << (bit & 31);
    }
    if (bit % 11 === 0) {
      rightBits.push(bit);
      rightWords[bit >>> 5] |= 1 << (bit & 31);
    }
  }
  const left = FixedBitSet.from(capacity, leftBits);
  const right = FixedBitSet.from(capacity, rightBits);
  const simdTarget = left.clone();
  const scalarTarget = leftWords.slice();

  bench("SIMD intersectionCount", () => left.intersectionCount(right));
  bench("scalar Uint32Array intersectionCount", () => {
    scalarIntersectionCount(leftWords, rightWords);
  });
  bench("SIMD unionWith", () => simdTarget.unionWith(right));
  bench("scalar Uint32Array union", () => scalarUnionInto(scalarTarget, rightWords));
});
