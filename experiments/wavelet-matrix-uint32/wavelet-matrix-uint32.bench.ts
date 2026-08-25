import { afterAll, bench, describe } from "vitest";
import { WaveletMatrixUint32 } from "../../src/wavelet-matrix-uint32/mod.ts";

function lowerBound(values: Uint32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function scalarRangeFreq(
  values: Uint32Array,
  left: number,
  right: number,
  min: number,
  max: number,
): number {
  let count = 0;
  for (let index = left; index < right; index++) {
    const value = values[index]!;
    if (value >= min && value < max) count++;
  }
  return count;
}

function scalarQuantile(values: Uint32Array, left: number, right: number, kth: number): number {
  return values.slice(left, right).sort()[kth]!;
}

describe.each([16_384, 262_144])("WaveletMatrixUint32 length=%i", (length) => {
  const values = Uint32Array.from(
    { length },
    (_, index) => Math.imul(index ^ (index >>> 3), 2_654_435_761) >>> 0,
  );
  const matrix = WaveletMatrixUint32.from(values);
  const positionsByValue = new Map<number, number[]>();
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    const positions = positionsByValue.get(value);
    if (positions) positions.push(index);
    else positionsByValue.set(value, [index]);
  }
  const indexedPositions = new Map<number, Uint32Array>();
  for (const [value, positions] of positionsByValue) {
    indexedPositions.set(value, Uint32Array.from(positions));
  }

  const queryCount = 512;
  const indices = Uint32Array.from(
    { length: queryCount },
    (_, index) => Math.imul(index + 17, 40_503) % length,
  );
  const queryValues = Uint32Array.from(indices, (index) => values[index]!);
  const ends = Uint32Array.from(
    { length: queryCount },
    (_, index) => Math.imul(index + 31, 65_537) % (length + 1),
  );
  const rankOutput = new Uint32Array(queryCount);
  const accessOutput = new Uint32Array(queryCount);

  const rangeQueryCount = 64;
  const lefts = new Uint32Array(rangeQueryCount);
  const rights = new Uint32Array(rangeQueryCount);
  const kths = new Uint32Array(rangeQueryCount);
  for (let query = 0; query < rangeQueryCount; query++) {
    const left = Math.imul(query + 7, 8_191) % length;
    const right = Math.min(length, left + 4_096);
    lefts[query] = left;
    rights[query] = right;
    kths[query] = (query * 97) % (right - left);
  }
  const quantileOutput = new Uint32Array(rangeQueryCount);

  let sink = 0;
  afterAll(() => matrix.dispose());

  bench("batch access", () => {
    matrix.accessMany(indices, accessOutput);
    sink ^= accessOutput[0]!;
  });
  bench("Uint32Array access", () => {
    for (const index of indices) sink ^= values[index]!;
  });
  bench("batch rank", () => {
    matrix.rankMany(queryValues, ends, rankOutput);
    sink ^= rankOutput[0]!;
  });
  bench("Map<value, positions> rank", () => {
    for (let query = 0; query < queryCount; query++) {
      sink ^= lowerBound(indexedPositions.get(queryValues[query]!)!, ends[query]!);
    }
  });
  bench("batch quantile", () => {
    matrix.quantileMany(lefts, rights, kths, quantileOutput);
    sink ^= quantileOutput[0]!;
  });
  bench("copy-sort quantile", () => {
    for (let query = 0; query < rangeQueryCount; query++) {
      sink ^= scalarQuantile(values, lefts[query]!, rights[query]!, kths[query]!);
    }
  });
  bench("rangeFreq", () => {
    for (let query = 0; query < rangeQueryCount; query++) {
      sink ^= matrix.rangeFreq(lefts[query]!, rights[query]!, 0x4000_0000, 0xc000_0000);
    }
  });
  bench("scalar range scan", () => {
    for (let query = 0; query < rangeQueryCount; query++) {
      sink ^= scalarRangeFreq(
        values,
        lefts[query]!,
        rights[query]!,
        0x4000_0000,
        0xc000_0000,
      );
    }
  });
});
