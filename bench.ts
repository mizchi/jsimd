import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  jsonTokenStarts,
  lexicalCompare,
  reverseFindByte,
} from "./src/bytes/mod.ts";
import { FixedBitSet } from "./src/bitset/mod.ts";
import { SimdFloat32Vector } from "./src/f32-vector/mod.ts";

let sink = 0;
let _bigSink = 0n;

for (const length of [32, 64, 128, 256, 1024, 4096, 16_384, 65_536]) {
  const input = new Uint8Array(length).fill(0x61);
  Deno.bench(`jsimd findByte miss n=${length}`, () => {
    sink ^= findByte(input, 0x5a);
  });
  Deno.bench(`Uint8Array#indexOf miss n=${length}`, () => {
    sink ^= input.indexOf(0x5a);
  });
}

function scalarPopcount(word: number): number {
  word -= (word >>> 1) & 0x5555_5555;
  word = (word & 0x3333_3333) + ((word >>> 2) & 0x3333_3333);
  return (((word + (word >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

function scalarIntersectionCount(left: Uint32Array, right: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < left.length; index++) {
    count += scalarPopcount(left[index]! & right[index]!);
  }
  return count;
}

function scalarUnionInto(left: Uint32Array, right: Uint32Array): void {
  for (let index = 0; index < left.length; index++) left[index] = left[index]! | right[index]!;
}

function wordsToBigInt(words: Uint32Array): bigint {
  let hex = "";
  for (let index = words.length - 1; index >= 0; index--) {
    hex += words[index]!.toString(16).padStart(8, "0");
  }
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function scalarDot(left: Float32Array, right: Float32Array): number {
  let result = 0;
  for (let index = 0; index < left.length; index++) result += left[index]! * right[index]!;
  return result;
}

function scalarAxpy(target: Float32Array, source: Float32Array, scale: number): void {
  for (let index = 0; index < target.length; index++) {
    target[index] = target[index]! + source[index]! * scale;
  }
}

for (const length of [16, 64, 1024, 16_384, 262_144, 4_194_304]) {
  const leftValues = Float32Array.from({ length }, (_, index) => (index % 251) * 0.001);
  const rightValues = Float32Array.from({ length }, (_, index) => (index % 127) * 0.002 - 0.1);
  const simdLeft = SimdFloat32Vector.from(leftValues);
  const simdRight = SimdFloat32Vector.from(rightValues);
  const scalarTarget = leftValues.slice();
  Deno.bench(`f32 SIMD resident dot n=${length}`, () => {
    sink ^= Math.trunc(simdLeft.dot(simdRight));
  });
  Deno.bench(`f32 Float32Array scalar dot n=${length}`, () => {
    sink ^= Math.trunc(scalarDot(leftValues, rightValues));
  });
  Deno.bench(`f32 SIMD resident axpy n=${length}`, () => {
    simdLeft.addScaled(simdRight, 0.000_001);
  });
  Deno.bench(`f32 Float32Array scalar axpy n=${length}`, () => {
    scalarAxpy(scalarTarget, rightValues, 0.000_001);
  });
}

for (const capacity of [1024, 16_384, 262_144, 4_194_304]) {
  const leftIndices: number[] = [];
  const rightIndices: number[] = [];
  const leftWords = new Uint32Array(Math.ceil(capacity / 32));
  const rightWords = new Uint32Array(Math.ceil(capacity / 32));
  const leftSet = new Set<number>();
  const rightSet = new Set<number>();
  for (let bit = 0; bit < capacity; bit++) {
    if (bit % 7 === 0) {
      leftIndices.push(bit);
      leftSet.add(bit);
      leftWords[bit >>> 5] = leftWords[bit >>> 5]! | (1 << (bit & 31));
    }
    if (bit % 11 === 0) {
      rightIndices.push(bit);
      rightSet.add(bit);
      rightWords[bit >>> 5] = rightWords[bit >>> 5]! | (1 << (bit & 31));
    }
  }
  const left = FixedBitSet.from(capacity, leftIndices);
  const right = FixedBitSet.from(capacity, rightIndices);
  const unionTarget = left.clone();
  const scalarUnionTarget = leftWords.slice();
  const leftBigInt = wordsToBigInt(leftWords);
  const rightBigInt = wordsToBigInt(rightWords);
  Deno.bench(`bitset SIMD intersectionCount n=${capacity}`, () => {
    sink ^= left.intersectionCount(right);
  });
  Deno.bench(`bitset Uint32 scalar intersectionCount n=${capacity}`, () => {
    sink ^= scalarIntersectionCount(leftWords, rightWords);
  });
  Deno.bench(`bitset Set intersectionCount n=${capacity}`, () => {
    let count = 0;
    for (const bit of rightSet) if (leftSet.has(bit)) count++;
    sink ^= count;
  });
  Deno.bench(`bitset Set builtin intersection size n=${capacity}`, () => {
    sink ^= leftSet.intersection(rightSet).size;
  });
  Deno.bench(`bitset SIMD unionWith n=${capacity}`, () => {
    unionTarget.unionWith(right);
    sink ^= Number(unionTarget.has(0));
  });
  Deno.bench(`bitset Uint32 scalar union n=${capacity}`, () => {
    scalarUnionInto(scalarUnionTarget, rightWords);
    sink ^= scalarUnionTarget[0]!;
  });
  Deno.bench(`bitset BigInt union n=${capacity}`, () => {
    _bigSink = leftBigInt | rightBigInt;
  });
  Deno.bench(`bitset Set builtin union size n=${capacity}`, () => {
    sink ^= leftSet.union(rightSet).size;
  });
}

function scalarJsonTokenStarts(input: Uint8Array): Uint32Array {
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let previousIsAtom = false;
  for (let offset = 0; offset < input.length; offset++) {
    const byte = input[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) {
        starts.push(offset);
        inString = false;
      }
      previousIsAtom = false;
    } else if (byte === 34) {
      starts.push(offset);
      inString = true;
      previousIsAtom = false;
    } else if (
      byte === 123 || byte === 125 || byte === 91 || byte === 93 || byte === 58 || byte === 44
    ) {
      starts.push(offset);
      previousIsAtom = false;
    } else if (byte === 32 || byte === 9 || byte === 10 || byte === 13) {
      previousIsAtom = false;
    } else {
      if (!previousIsAtom) starts.push(offset);
      previousIsAtom = true;
    }
  }
  return new Uint32Array(starts);
}

function scalarFindNonAscii(input: Uint8Array): number {
  for (let index = 0; index < input.length; index++) if (input[index]! >= 0x80) return index;
  return -1;
}

function scalarBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function scalarLexicalCompare(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function scalarIndexOfSubarray(input: Uint8Array, pattern: Uint8Array): number {
  outer:
  for (let index = 0; index + pattern.length <= input.length; index++) {
    for (let offset = 0; offset < pattern.length; offset++) {
      if (input[index + offset] !== pattern[offset]) continue outer;
    }
    return index;
  }
  return pattern.length === 0 ? 0 : -1;
}

for (const length of [128, 256, 4096, 65_536]) {
  const input = new Uint8Array(length).fill(0x61);
  const copy = input.slice();
  Deno.bench(`jsimd reverseFindByte miss n=${length}`, () => {
    sink ^= reverseFindByte(input, 0x5a);
  });
  Deno.bench(`Uint8Array#lastIndexOf miss n=${length}`, () => {
    sink ^= input.lastIndexOf(0x5a);
  });
  Deno.bench(`jsimd findNonAscii ASCII n=${length}`, () => {
    sink ^= findNonAscii(input);
  });
  Deno.bench(`scalar findNonAscii ASCII n=${length}`, () => {
    sink ^= scalarFindNonAscii(input);
  });
  Deno.bench(`jsimd bytesEqual equal n=${length}`, () => {
    sink ^= Number(bytesEqual(input, copy));
  });
  Deno.bench(`scalar bytesEqual equal n=${length}`, () => {
    sink ^= Number(scalarBytesEqual(input, copy));
  });
}

for (const length of [256, 4096, 65_536]) {
  const left = new Uint8Array(length).fill(0x61);
  const right = left.slice();
  const pattern = new Uint8Array([0x61, 0x61, 0x61, 0x5a]);
  Deno.bench(`jsimd lexicalCompare equal n=${length}`, () => {
    sink ^= lexicalCompare(left, right);
  });
  Deno.bench(`scalar lexicalCompare equal n=${length}`, () => {
    sink ^= scalarLexicalCompare(left, right);
  });
  Deno.bench(`jsimd indexOfSubarray miss n=${length}`, () => {
    sink ^= indexOfSubarray(left, pattern);
  });
  Deno.bench(`scalar indexOfSubarray miss n=${length}`, () => {
    sink ^= scalarIndexOfSubarray(left, pattern);
  });
}

const encoder = new TextEncoder();
for (
  const [name, source] of [
    ["mixed", new Array(1000).fill('{"id":123,"ok":true,"name":"moonbit"}').join(",")],
    ["dense", new Array(10_000).fill("[0,1]").join(",")],
    ["strings", JSON.stringify(new Array(1000).fill("a".repeat(64) + '\\"tail'))],
  ] as const
) {
  const input = encoder.encode(`[${source}]`);
  Deno.bench(`jsimd jsonTokenStarts ${name} n=${input.length}`, () => {
    sink ^= jsonTokenStarts(input).length;
  });
  Deno.bench(`scalar jsonTokenStarts ${name} n=${input.length}`, () => {
    sink ^= scalarJsonTokenStarts(input).length;
  });
}
