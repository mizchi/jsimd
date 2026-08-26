import { afterAll, bench, describe } from "vitest";
import { WaveletMatrixUint32 } from "../../src/wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "../../src/wavelet-matrix-uint8/mod.ts";

const LENGTH = 262_144;
const QUERY_COUNT = 4096;
const values = Uint8Array.from(
  { length: LENGTH },
  (_, index) => (index * 73 + (index >>> 7)) & 255,
);
const values32 = Uint32Array.from(values);
const rankValues = Uint8Array.from({ length: QUERY_COUNT }, (_, index) => index & 255);
const rankValues32 = Uint32Array.from(rankValues);
const ends = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => (index * 65_537) & (LENGTH - 1),
);
const indices = Uint32Array.from(
  { length: QUERY_COUNT },
  (_, index) => (index * 131_071) & (LENGTH - 1),
);
let sink = 0;

describe("WaveletMatrixUint8 repeated queries", () => {
  const byteMatrix = WaveletMatrixUint8.from(values);
  const uint32Matrix = WaveletMatrixUint32.from(values32);
  const rankOutput = new Uint32Array(QUERY_COUNT);
  const byteAccess = new Uint8Array(QUERY_COUNT);
  const wideAccess = new Uint32Array(QUERY_COUNT);
  afterAll(() => {
    byteMatrix[Symbol.dispose]();
    uint32Matrix[Symbol.dispose]();
  });
  bench("Uint8 rankMany x4096", () => {
    sink ^= byteMatrix.rankMany(rankValues, ends, rankOutput)[0]!;
  });
  bench("Uint32 rankMany x4096", () => {
    sink ^= uint32Matrix.rankMany(rankValues32, ends, rankOutput)[0]!;
  });
  bench("Uint8 accessMany x4096", () => {
    sink ^= byteMatrix.accessMany(indices, byteAccess)[0]!;
  });
  bench("Uint32 accessMany x4096", () => {
    sink ^= uint32Matrix.accessMany(indices, wideAccess)[0]!;
  });
  bench("Uint8Array direct access x4096", () => {
    for (const index of indices) sink ^= values[index]!;
  });
});
