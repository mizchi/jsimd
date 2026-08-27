import { bench, describe } from "vitest";
import { BinaryVectorIndex } from "../../packages/jsimd/src/binary-vector-index/mod.ts";
import { CompressedStringTable } from "../../packages/jsimd/src/compressed-string-table/mod.ts";
import { EliasFanoSequence } from "../../packages/jsimd/src/elias-fano-sequence/mod.ts";
import { FmIndexBytes } from "../../packages/jsimd/src/fm-index-bytes/mod.ts";
import { StaticMphfU32 } from "../../packages/jsimd/src/static-mphf-u32/mod.ts";
import { WaveletMatrixUint32 } from "../../packages/jsimd/src/wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "../../packages/jsimd/src/wavelet-matrix-uint8/mod.ts";

const fmText = Uint8Array.from(
  { length: 8_192 },
  (_, index) => 97 + ((index * 17 + (index >>> 4)) % 23),
);
const waveletU8Values = Uint8Array.from(
  { length: 65_536 },
  (_, index) => Math.imul(index, 37) & 0xff,
);
const waveletU32Values = Uint32Array.from(
  { length: 65_536 },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const mphfKeys = Uint32Array.from(
  { length: 16_384 },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const strings = Array.from(
  { length: 16_384 },
  (_, index) => `src/component/${index >>> 4}/item-${index}.tsx`,
);
const monotoneValues = Uint32Array.from(
  { length: 65_536 },
  (_, index) => index * 7 + Math.floor(index / 11),
);
const vectorDimensions = 256;
const vectorCount = 8_192;
const vectorValues = Float32Array.from(
  { length: vectorCount * vectorDimensions },
  (_, index) => ((Math.imul(index, 17) % 101) - 50) / 50,
);

const fmSnapshot = snapshot(() => FmIndexBytes.from(fmText));
const waveletU8Snapshot = snapshot(() => WaveletMatrixUint8.from(waveletU8Values));
const waveletU32Snapshot = snapshot(() => WaveletMatrixUint32.from(waveletU32Values));
const mphfSnapshot = snapshot(() => StaticMphfU32.fromUint32Array(mphfKeys));
const stringSnapshot = snapshot(() => CompressedStringTable.fromUtf8(strings));
const eliasFanoSnapshot = snapshot(() => EliasFanoSequence.fromUint32Array(monotoneValues));
const binarySnapshot = snapshot(() =>
  BinaryVectorIndex.fromFloat32(vectorValues, vectorCount, vectorDimensions)
);

let sink = 0;

describe("versioned snapshot build versus resident restore", () => {
  compare(
    "FmIndexBytes 8K",
    () => FmIndexBytes.from(fmText),
    () => FmIndexBytes.fromSnapshot(fmSnapshot),
  );
  compare(
    "WaveletMatrixUint8 64K",
    () => WaveletMatrixUint8.from(waveletU8Values),
    () => WaveletMatrixUint8.fromSnapshot(waveletU8Snapshot),
  );
  compare(
    "WaveletMatrixUint32 64K",
    () => WaveletMatrixUint32.from(waveletU32Values),
    () => WaveletMatrixUint32.fromSnapshot(waveletU32Snapshot),
  );
  compare(
    "StaticMphfU32 16K",
    () => StaticMphfU32.fromUint32Array(mphfKeys),
    () => StaticMphfU32.fromSnapshot(mphfSnapshot),
  );
  compare(
    "CompressedStringTable 16K",
    () => CompressedStringTable.fromUtf8(strings),
    () => CompressedStringTable.fromSnapshot(stringSnapshot),
  );
  compare(
    "EliasFanoSequence 64K",
    () => EliasFanoSequence.fromUint32Array(monotoneValues),
    () => EliasFanoSequence.fromSnapshot(eliasFanoSnapshot),
  );
  compare(
    "BinaryVectorIndex 8K x 256",
    () => BinaryVectorIndex.fromFloat32(vectorValues, vectorCount, vectorDimensions),
    () => BinaryVectorIndex.fromSnapshot(binarySnapshot),
  );
});

describe("snapshot host copy", () => {
  bench("structuredClone 256 KiB binary snapshot", () => {
    sink ^= structuredClone(binarySnapshot).byteLength;
  });
});

function snapshot<T extends Disposable & { serialize(): Uint8Array }>(build: () => T): Uint8Array {
  using value = build();
  return value.serialize();
}

function compare<T extends Disposable & { readonly length: number }>(
  name: string,
  build: () => T,
  restore: () => T,
): void {
  bench(`${name}: build`, () => {
    using value = build();
    sink ^= value.length;
  });
  bench(`${name}: fromSnapshot`, () => {
    using value = restore();
    sink ^= value.length;
  });
}
