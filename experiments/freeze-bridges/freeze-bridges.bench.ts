import { afterAll, bench, describe } from "vitest";
import { Bitmap } from "../../src/bitmap/mod.ts";
import { RankSelectBitVector } from "../../src/rank-select-bit-vector/mod.ts";
import { FlatHashSetU32 } from "../../src/flat-hash/mod.ts";
import { StaticMphfU32 } from "../../src/static-mphf-u32/mod.ts";
import { EliasFanoSequence, MonotoneUint32Builder } from "../../src/elias-fano-sequence/mod.ts";
import { PackedDeltaUint32List } from "../../src/packed-delta-uint32-list/mod.ts";

let sink = 0;

const BIT_CAPACITY = 262_144;
const bitPositions = Array.from({ length: BIT_CAPACITY >>> 2 }, (_, index) => index * 4);
const bitmap = Bitmap.from(bitPositions);
const bitmapWords = new Uint32Array(Math.ceil(bitmap.capacity / 32));
bitmap.wordsInto(bitmapWords);

const KEY_COUNT = 4_096;
const keys = Uint32Array.from(
  { length: KEY_COUNT },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const flatHash = FlatHashSetU32.from(keys);
const flatHashKeys = flatHash.toUint32Array();

const MONOTONE_COUNT = 65_536;
const monotone = Uint32Array.from({ length: MONOTONE_COUNT }, (_, index) => index * 3);
const monotoneBuilder = new MonotoneUint32Builder();
for (const value of monotone) monotoneBuilder.append(value);

afterAll(() => {
  flatHash[Symbol.dispose]();
  bitmap[Symbol.dispose]();
});

describe("explicit mutable-to-frozen bridge construction", () => {
  bench("Bitmap -> RankSelectBitVector", () => {
    using frozen = RankSelectBitVector.fromBitmap(bitmap);
    sink ^= frozen.countOnes;
  });
  bench("packed words -> RankSelectBitVector", () => {
    using frozen = RankSelectBitVector.fromUint32Array(bitmap.capacity, bitmapWords);
    sink ^= frozen.countOnes;
  });
  bench("FlatHashSetU32 -> StaticMphfU32", () => {
    using frozen = StaticMphfU32.fromFlatHashSet(flatHash);
    sink ^= frozen.length;
  });
  bench("Uint32Array -> StaticMphfU32", () => {
    using frozen = StaticMphfU32.fromUint32Array(flatHashKeys);
    sink ^= frozen.length;
  });
  bench("Monotone builder -> EliasFano", () => {
    using frozen = EliasFanoSequence.fromMonotone(monotoneBuilder);
    sink ^= frozen.length;
  });
  bench("Uint32Array -> EliasFano", () => {
    using frozen = EliasFanoSequence.fromUint32Array(monotone);
    sink ^= frozen.length;
  });
  bench("Monotone builder -> PackedDelta", () => {
    using frozen = PackedDeltaUint32List.fromMonotone(monotoneBuilder);
    sink ^= frozen.length;
  });
  bench("Uint32Array -> PackedDelta", () => {
    using frozen = PackedDeltaUint32List.fromUint32Array(monotone);
    sink ^= frozen.length;
  });
});
