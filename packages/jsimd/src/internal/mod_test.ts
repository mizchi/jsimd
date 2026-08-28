import { Bitmap } from "../bitmap/mod.ts";
import { RankSelectBitVector } from "../rank-select-bit-vector/mod.ts";
import { PackedDeltaUint32List } from "../packed-delta-uint32-list/mod.ts";
import { WaveletMatrixUint32 } from "../wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "../wavelet-matrix-uint8/mod.ts";
import { FmIndexBytes } from "../fm-index-bytes/mod.ts";
import { CompressedStringTable } from "../compressed-string-table/mod.ts";
import { EliasFanoSequence, MonotoneUint32Builder } from "../elias-fano-sequence/mod.ts";
import { StaticMphfU32 } from "../static-mphf-u32/mod.ts";
import { BinaryVectorIndex } from "../binary-vector-index/mod.ts";
import { FlatHashMapFixed16U32 } from "../flat-hash-fixed16/mod.ts";
import { ByteKeyFlatHashMapU32 } from "../byte-key-flat-hash/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("fixed and variable byte-key maps enumerate entries into flat buffers", () => {
  const keyA = new Uint8Array(16).fill(0x11);
  const keyB = new Uint8Array(16).fill(0x22);
  using fixed = FlatHashMapFixed16U32.from([[keyA, 1], [keyB, 2]]);
  const fixedKeys = new Uint8Array(32);
  const fixedValues = new Uint32Array(2);
  assertEquals(fixed.entriesInto(fixedKeys, fixedValues), 2, "fixed entries count");
  const fixedRestored = new Map<number, number>();
  for (let index = 0; index < 2; index++) {
    fixedRestored.set(fixedKeys[index * 16]!, fixedValues[index]!);
  }
  assertEquals(fixedRestored.get(0x11), 1, "fixed key A");
  assertEquals(fixedRestored.get(0x22), 2, "fixed key B");

  const encoder = new TextEncoder();
  using bytes = ByteKeyFlatHashMapU32.from([
    [encoder.encode("a"), 1],
    [encoder.encode("long"), 2],
    [new Uint8Array(), 3],
  ]);
  const keyBytes = new Uint8Array(5);
  const offsets = new Uint32Array(4);
  const values = new Uint32Array(3);
  assertEquals(bytes.entriesInto(keyBytes, offsets, values), 3, "byte entries count");
  const restoredBytes = new Map<string, number>();
  const decoder = new TextDecoder();
  for (let index = 0; index < 3; index++) {
    restoredBytes.set(
      decoder.decode(keyBytes.subarray(offsets[index], offsets[index + 1])),
      values[index]!,
    );
  }
  assertEquals(restoredBytes.get("a"), 1, "byte key a");
  assertEquals(restoredBytes.get("long"), 2, "byte key long");
  assertEquals(restoredBytes.get(""), 3, "empty byte key");
});

Deno.test("versioned snapshots restore frozen indexes without their construction input", () => {
  const encoder = new TextEncoder();
  const text = encoder.encode("banana bandana");
  const fmSnapshot = (() => {
    using index = FmIndexBytes.from(text);
    return index.serialize();
  })();
  using fm = FmIndexBytes.fromSnapshot(fmSnapshot);
  assertEquals(fm.count(encoder.encode("ana")), 3, "restored FM count");
  assertEquals(fm.locate(encoder.encode("band")).join(","), "7", "restored FM locate");

  const u8Values = Uint8Array.of(9, 1, 7, 1, 5, 1, 3);
  const u8Snapshot = (() => {
    using matrix = WaveletMatrixUint8.from(u8Values);
    return matrix.serialize();
  })();
  using u8 = WaveletMatrixUint8.fromSnapshot(u8Snapshot);
  assertEquals(u8.access(4), 5, "restored u8 access");
  assertEquals(u8.rank(1, u8.length), 3, "restored u8 rank");

  const u32Values = Uint32Array.of(0xffff_ffff, 3, 1, 3, 0x8000_0000);
  const u32Snapshot = (() => {
    using matrix = WaveletMatrixUint32.from(u32Values);
    return matrix.serialize();
  })();
  using u32 = WaveletMatrixUint32.fromSnapshot(u32Snapshot);
  assertEquals(u32.access(4), 0x8000_0000, "restored u32 access");
  assertEquals(u32.rank(3, u32.length), 2, "restored u32 rank");
});

Deno.test("versioned snapshots preserve compact tables and ordered sequences", () => {
  const keys = Uint32Array.of(3, 7, 11, 0xffff_ffff);
  const mphfSnapshot = (() => {
    using index = StaticMphfU32.fromUint32Array(keys);
    return index.serialize();
  })();
  using mphf = StaticMphfU32.fromSnapshot(mphfSnapshot);
  const ids = Array.from(keys, (key) => mphf.lookup(key));
  assertEquals(new Set(ids).size, keys.length, "restored MPHF unique IDs");

  const strings = ["alpha", "alphabet", "alpine", "beta", "betamax"];
  const tableSnapshot = (() => {
    using table = CompressedStringTable.fromUtf8(strings);
    return table.serialize();
  })();
  using table = CompressedStringTable.fromSnapshot(tableSnapshot);
  assertEquals(new TextDecoder().decode(table.get(2)), "alpine", "restored string table");

  const values = Uint32Array.of(0, 1, 1, 8, 1024, 0xffff_ffff);
  const sequenceSnapshot = (() => {
    using sequence = EliasFanoSequence.fromUint32Array(values);
    return sequence.serialize();
  })();
  using sequence = EliasFanoSequence.fromSnapshot(sequenceSnapshot);
  assertEquals(sequence.toUint32Array().join(","), values.join(","), "restored EF values");
  assertEquals(sequence.rank(9), 4, "restored EF rank");
});

Deno.test("versioned snapshots preserve binary signatures and logical dimensions", () => {
  const values = Float32Array.of(
    1,
    -1,
    1,
    -1,
    1,
    -1,
    1,
    -1,
    1,
    -1,
    1,
    1,
    -1,
    -1,
    1,
  );
  const snapshot = (() => {
    using index = BinaryVectorIndex.fromFloat32(values, 3, 5);
    return index.serialize();
  })();
  using restored = BinaryVectorIndex.fromSnapshot(snapshot);
  assertEquals(restored.length, 3, "restored vector count");
  assertEquals(restored.dimensions, 5, "restored logical dimensions");
  assertEquals(
    restored.distanceMany(Uint8Array.of(0b0001_0101), new Uint32Array(3)).join(","),
    "0,5,2",
    "restored Hamming distances",
  );
});

Deno.test("versioned snapshots reject incompatible and truncated inputs before allocation", () => {
  const snapshot = (() => {
    using matrix = WaveletMatrixUint8.from(Uint8Array.of(1, 2, 3, 2, 1));
    return matrix.serialize();
  })();
  const beforeU8 = WaveletMatrixUint8.allocatorStats();
  const beforeU32 = WaveletMatrixUint32.allocatorStats();

  const invalidVersion = snapshot.slice();
  invalidVersion[4] = 0xff;
  const invalidPayload = snapshot.slice();
  invalidPayload[32] ^= 1;
  for (
    const attempt of [
      () => WaveletMatrixUint8.fromSnapshot(snapshot.subarray(0, snapshot.length - 1)),
      () => WaveletMatrixUint8.fromSnapshot(invalidVersion),
      () => WaveletMatrixUint8.fromSnapshot(invalidPayload),
      () => WaveletMatrixUint32.fromSnapshot(snapshot),
    ]
  ) {
    let threw = false;
    try {
      attempt();
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assertEquals(threw, true, "invalid snapshot rejected");
  }

  const afterU8 = WaveletMatrixUint8.allocatorStats();
  const afterU32 = WaveletMatrixUint32.allocatorStats();
  assertEquals(afterU8.liveAllocations, beforeU8.liveAllocations, "u8 failed restore allocations");
  assertEquals(afterU8.liveBytes, beforeU8.liveBytes, "u8 failed restore bytes");
  assertEquals(afterU32.liveAllocations, beforeU32.liveAllocations, "u32 cross-kind allocations");
  assertEquals(afterU32.liveBytes, beforeU32.liveBytes, "u32 cross-kind bytes");
});

Deno.test("snapshot restore validates structure metadata and accepts unaligned byte views", () => {
  const mphfSnapshot = (() => {
    using index = StaticMphfU32.from([3, 7, 11, 19]);
    return index.serialize();
  })();
  const unaligned = new Uint8Array(mphfSnapshot.length + 1);
  unaligned.set(mphfSnapshot, 1);
  using mphf = StaticMphfU32.fromSnapshot(unaligned.subarray(1));
  assertEquals(mphf.lookup(11) >= 0, true, "unaligned snapshot view");

  const fmSnapshot = (() => {
    using index = FmIndexBytes.from(new TextEncoder().encode("banana"));
    return index.serialize();
  })();
  const invalidFmShape = fmSnapshot.slice();
  new DataView(invalidFmShape.buffer).setUint32(20, 99, true);
  const beforeFm = FmIndexBytes.allocatorStats();
  let fmThrew = false;
  try {
    FmIndexBytes.fromSnapshot(invalidFmShape);
  } catch (error) {
    fmThrew = error instanceof RangeError;
  }
  assertEquals(fmThrew, true, "invalid FM shape rejected");
  assertEquals(
    FmIndexBytes.allocatorStats().liveAllocations,
    beforeFm.liveAllocations,
    "invalid FM restore allocations",
  );

  const binarySnapshot = (() => {
    using index = BinaryVectorIndex.fromFloat32(Float32Array.of(1, -1, 1, -1, 1), 1, 5);
    return index.serialize();
  })();
  const invalidPadding = binarySnapshot.slice();
  invalidPadding[33] = 1; // Header is 32 bytes; byte 1 of the resident row is padding.
  const beforeBinary = BinaryVectorIndex.allocatorStats();
  let binaryThrew = false;
  try {
    BinaryVectorIndex.fromSnapshot(invalidPadding);
  } catch (error) {
    binaryThrew = error instanceof RangeError;
  }
  assertEquals(binaryThrew, true, "non-zero binary padding rejected");
  assertEquals(
    BinaryVectorIndex.allocatorStats().liveAllocations,
    beforeBinary.liveAllocations,
    "invalid binary restore allocations",
  );
});

Deno.test("Bitmap freezes into an independent RankSelectBitVector through packed words", () => {
  using mutable = Bitmap.from([1, 31, 32, 100]);
  using frozen = RankSelectBitVector.fromBitmap(mutable);
  assertEquals(frozen.length, mutable.capacity, "bitmap bridge capacity");
  assertEquals(frozen.countOnes, 4, "bitmap bridge cardinality");
  assertEquals(frozen.select1(2), 32, "bitmap bridge select");
  mutable.insert(101).remove(1);
  assertEquals(frozen.get(1), true, "frozen bitmap snapshot keeps removed bit");
  assertEquals(frozen.get(101), false, "frozen bitmap snapshot ignores later insert");

  const words = new Uint32Array(Math.ceil(mutable.capacity / 32) + 1).fill(0xdead_beef);
  assertEquals(mutable.wordsInto(words), Math.ceil(mutable.capacity / 32), "bitmap word count");
  assertEquals(words.at(-1), 0xdead_beef, "bitmap word output tail");
});

Deno.test("MonotoneUint32Builder explicitly freezes into either ordered encoding", () => {
  const source = new MonotoneUint32Builder();
  for (const value of [3, 8, 20, 100, 1_000]) source.append(value);
  using eliasFano = EliasFanoSequence.fromMonotone(source);
  using packedDelta = PackedDeltaUint32List.fromMonotone(source);
  assertEquals(eliasFano.toUint32Array().join(","), "3,8,20,100,1000", "EF bridge");
  assertEquals(packedDelta.toUint32Array().join(","), "3,8,20,100,1000", "delta bridge");

  const duplicates = new MonotoneUint32Builder().append(1).append(1);
  using duplicateEf = EliasFanoSequence.fromMonotone(duplicates);
  assertEquals(duplicateEf.length, 2, "EF accepts duplicate source");
  let strictThrew = false;
  try {
    PackedDeltaUint32List.fromMonotone(duplicates);
  } catch (error) {
    strictThrew = error instanceof RangeError;
  }
  assertEquals(strictThrew, true, "PackedDelta rejects duplicate source");
});
