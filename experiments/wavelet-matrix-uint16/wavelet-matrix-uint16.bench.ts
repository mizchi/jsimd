import { afterAll, bench, describe } from "vitest";
import { WaveletMatrixUint16 } from "../../src/wavelet-matrix-uint16/mod.ts";
import { WaveletMatrixUint32 } from "../../src/wavelet-matrix-uint32/mod.ts";

const LENGTH = 262_144;
const BATCH_QUERIES = 4_096;
const RANGE_QUERIES = 64;
const RANGE_LENGTH = 4_096;
const values = Uint16Array.from(
  { length: LENGTH },
  (_, index) => (Math.imul(index, 40_501) + (index >>> 5) * 257) & 0xffff,
);
const values32 = Uint32Array.from(values);
const rankValues = Uint16Array.from(
  { length: BATCH_QUERIES },
  (_, index) => (Math.imul(index, 8_191) + 97) & 0xffff,
);
const rankValues32 = Uint32Array.from(rankValues);
const ends = Uint32Array.from(
  { length: BATCH_QUERIES },
  (_, index) => (Math.imul(index, 65_537) >>> 0) & (LENGTH - 1),
);
const indices = Uint32Array.from(
  { length: BATCH_QUERIES },
  (_, index) => Math.imul(index, 131_071) & (LENGTH - 1),
);
const lefts = Uint32Array.from(
  { length: RANGE_QUERIES },
  (_, index) => Math.imul(index, 3_971) % (LENGTH - RANGE_LENGTH),
);
const rights = Uint32Array.from(lefts, (left) => left + RANGE_LENGTH);
const kths = Uint32Array.from({ length: RANGE_QUERIES }, (_, index) => index * 61 % RANGE_LENGTH);
const positions = buildPositions(values);
let sink = 0;

describe("WaveletMatrixUint16 repeated queries", () => {
  const uint16Matrix = WaveletMatrixUint16.from(values);
  const uint32Matrix = WaveletMatrixUint32.from(values32);
  const rankOutput = new Uint32Array(BATCH_QUERIES);
  const accessOutput = new Uint16Array(BATCH_QUERIES);
  const quantile16Output = new Uint16Array(RANGE_QUERIES);
  const quantile32Output = new Uint32Array(RANGE_QUERIES);
  afterAll(() => {
    uint16Matrix[Symbol.dispose]();
    uint32Matrix[Symbol.dispose]();
  });

  bench("Uint16 rankMany x4096", () => {
    sink ^= uint16Matrix.rankMany(rankValues, ends, rankOutput)[0]!;
  });

  bench("Uint32 rankMany x4096", () => {
    sink ^= uint32Matrix.rankMany(rankValues32, ends, rankOutput)[0]!;
  });

  bench("indexed JS rank x4096", () => {
    for (let query = 0; query < BATCH_QUERIES; query++) {
      sink ^= lowerBound(positions.get(rankValues[query]!), ends[query]!);
    }
  });

  bench("Uint16 accessMany x4096", () => {
    sink ^= uint16Matrix.accessMany(indices, accessOutput)[0]!;
  });

  bench("Uint16Array direct access x4096", () => {
    for (const index of indices) sink ^= values[index]!;
  });

  bench("Uint16 quantileMany x64", () => {
    sink ^= uint16Matrix.quantileMany(lefts, rights, kths, quantile16Output)[0]!;
  });

  bench("Uint32 quantileMany x64", () => {
    sink ^= uint32Matrix.quantileMany(lefts, rights, kths, quantile32Output)[0]!;
  });

  bench("copy-sort JS quantile x64", () => {
    for (let query = 0; query < RANGE_QUERIES; query++) {
      const sorted = values.slice(lefts[query]!, rights[query]!).sort();
      sink ^= sorted[kths[query]!]!;
    }
  });
});

function buildPositions(input: Uint16Array): Map<number, Uint32Array> {
  const mutable = new Map<number, number[]>();
  for (let index = 0; index < input.length; index++) {
    const value = input[index]!;
    const bucket = mutable.get(value);
    if (bucket === undefined) mutable.set(value, [index]);
    else bucket.push(index);
  }
  return new Map(Array.from(mutable, ([value, indices]) => [value, Uint32Array.from(indices)]));
}

function lowerBound(values: Uint32Array | undefined, target: number): number {
  if (values === undefined) return 0;
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}
