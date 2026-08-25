import { afterAll, bench, describe } from "vitest";
import { RankSelectBitVector } from "../../src/rank-select-bitvector/mod.ts";

let sink = 0;

function popcount(word: number): number {
  word -= (word >>> 1) & 0x5555_5555;
  word = (word & 0x3333_3333) + ((word >>> 2) & 0x3333_3333);
  return (((word + (word >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

function buildScalarIndex(words: Uint32Array): Uint32Array {
  const index = new Uint32Array(Math.ceil(words.length / 16) + 1);
  let count = 0;
  for (let word = 0; word < words.length; word++) {
    if ((word & 15) === 0) index[word >>> 4] = count;
    count += popcount(words[word]!);
  }
  index[index.length - 1] = count;
  return index;
}

function scalarRank1(words: Uint32Array, index: Uint32Array, end: number): number {
  const superblock = end >>> 9;
  const fullWords = end >>> 5;
  let count = index[superblock]!;
  for (let word = superblock << 4; word < fullWords; word++) count += popcount(words[word]!);
  const remaining = end & 31;
  if (remaining !== 0) count += popcount(words[fullWords]! & (0xffff_ffff >>> (32 - remaining)));
  return count;
}

function scalarSelect1(words: Uint32Array, index: Uint32Array, rank: number): number {
  let low = 0;
  let high = index.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (index[middle]! <= rank) low = middle;
    else high = middle - 1;
  }
  let remaining = rank - index[low]!;
  const end = Math.min(words.length, (low + 1) << 4);
  for (let wordIndex = low << 4; wordIndex < end; wordIndex++) {
    let word = words[wordIndex]!;
    const ones = popcount(word);
    if (remaining < ones) {
      while (remaining-- > 0) word = (word & (word - 1)) >>> 0;
      return (wordIndex << 5) + 31 - Math.clz32(word & -word);
    }
    remaining -= ones;
  }
  return -1;
}

describe.each([16_384, 262_144, 4_194_304])("RankSelectBitVector length=%i", (length) => {
  const positions: number[] = [];
  const words = new Uint32Array(Math.ceil(length / 32));
  for (let position = 0; position < length; position += 7) {
    positions.push(position);
    words[position >>> 5] |= 1 << (position & 31);
  }
  const index = buildScalarIndex(words);
  const bits = RankSelectBitVector.fromUint32Array(length, words);
  const queryCount = 1_024;
  const rankEnds = Uint32Array.from(
    { length: queryCount },
    (_, query) => (Math.imul(query, 2_654_435_761) >>> 0) % (length + 1),
  );
  const selectRanks = Uint32Array.from(
    { length: queryCount },
    (_, query) => (Math.imul(query, 2_246_822_519) >>> 0) % positions.length,
  );
  const rankOutput = new Uint32Array(queryCount);
  const selectOutput = new Int32Array(queryCount);

  afterAll(() => bits[Symbol.dispose]());

  bench("Wasm SIMD rank1 x1024", () => {
    let result = 0;
    for (const end of rankEnds) result ^= bits.rank1(end);
    sink ^= result;
  });
  bench("scalar indexed rank1 x1024", () => {
    let result = 0;
    for (const end of rankEnds) result ^= scalarRank1(words, index, end);
    sink ^= result;
  });
  bench("Wasm SIMD rank1Many x1024", () => {
    bits.rank1Many(rankEnds, rankOutput);
    sink ^= rankOutput[queryCount - 1]!;
  });
  bench("Wasm select1 x1024", () => {
    let result = 0;
    for (const rank of selectRanks) result ^= bits.select1(rank);
    sink ^= result;
  });
  bench("scalar indexed select1 x1024", () => {
    let result = 0;
    for (const rank of selectRanks) result ^= scalarSelect1(words, index, rank);
    sink ^= result;
  });
  bench("Wasm select1Many x1024", () => {
    bits.select1Many(selectRanks, selectOutput);
    sink ^= selectOutput[queryCount - 1]!;
  });
});
