import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "./src/bytes/mod.ts";
import { decodeUint32BE, decodeUint32LE } from "./src/endian/mod.ts";
import { Bitmap, DenseBitmap } from "./src/bitmap/mod.ts";
import { SimdFloat32Vector } from "./src/f32-vector/mod.ts";
import { SimdInt32Array } from "./src/i32-array/mod.ts";
import { SimdMatrix2D } from "./src/matrix2d/mod.ts";
import { SimdMatrix3D } from "./src/matrix3d/mod.ts";
import { BitVector, BitVectorBuilder } from "./src/bit-vector/mod.ts";
import { RoaringBitmap } from "./src/roaring-bitmap/mod.ts";
import {
  PackedDeltaUint32List,
  PackedDeltaUint32ListBuilder,
} from "./src/packed-delta-uint32-list/mod.ts";
import { FlatHashMapU32U32, FlatHashMapU64U32, FlatHashSetU32 } from "./src/flat-hash/mod.ts";
import { BitSlicedColumnU8, BitSliceMask } from "./src/bit-sliced-column/mod.ts";
import { jsonTokenStarts } from "./src/json/mod.ts";
import { WaveletMatrixUint32 } from "./src/wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "./src/wavelet-matrix-uint8/mod.ts";
import { FmIndexBytes } from "./src/fm-index-bytes/mod.ts";
import { CompressedStringTable } from "./src/compressed-string-table/mod.ts";
import {
  EliasFanoSequence,
  EliasFanoSequenceBuilder,
  PartitionedEliasFanoSequence,
  PartitionedEliasFanoSequenceBuilder,
} from "./src/elias-fano-sequence/mod.ts";
import {
  AdaptivePageEncoding,
  AdaptiveSimdColumnI32,
  AdaptiveSimdPageI32,
  SimdColumnMask,
  SimdPageMask,
} from "./src/adaptive-simd-page-i32/mod.ts";
import { StaticMphfU32, StaticMphfU32Builder } from "./src/static-mphf-u32/mod.ts";
import {
  FrozenByteMapU32,
  StaticMphfBytes,
  StaticMphfBytesBuilder,
} from "./src/static-mphf-bytes/mod.ts";
import {
  BinaryVectorIndex,
  BinaryVectorIndexWithRerank,
  PdxFloat32Index,
} from "./src/binary-vector-index/mod.ts";
import { BitMatrix, SparseBitMatrix } from "./src/bit-matrix/mod.ts";
import { FingerprintGroup16, FingerprintTable16 } from "./src/fingerprint-group16/mod.ts";
import { FlatHashMapFixed16U32, FlatHashSetFixed16 } from "./src/flat-hash-fixed16/mod.ts";
import { ByteKeyFlatHashMapU32 } from "./src/byte-key-flat-hash/mod.ts";

function assertEquals(actual: unknown, expected: unknown, context: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${context}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, context: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${context}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

Deno.test("SimdFloat32Vector computes dot product across SIMD boundaries", () => {
  for (const length of [0, 1, 3, 4, 5, 15, 16, 17, 1025]) {
    const leftValues = Float32Array.from({ length }, (_, index) => (index % 13) - 6.25);
    const rightValues = Float32Array.from({ length }, (_, index) => (index % 7) * 0.5 - 1.5);
    let expected = 0;
    for (let index = 0; index < length; index++) {
      expected += leftValues[index]! * rightValues[index]!;
    }
    const left = SimdFloat32Vector.from(leftValues);
    const right = SimdFloat32Vector.from(rightValues);
    assertClose(
      left.dot(right),
      expected,
      Math.max(1e-5, Math.abs(expected) * 1e-5),
      `n=${length}`,
    );
  }
});

Deno.test("SimdFloat32Vector performs in-place AXPY without exposing padding", () => {
  const target = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4, 5]));
  const source = SimdFloat32Vector.from(new Float32Array([2, -1, 0.5, 10, -2]));
  target.addScaled(source, 0.25);
  const actual = target.toFloat32Array();
  const expected = [1.5, 1.75, 3.125, 6.5, 4.5];
  assertEquals(actual.length, expected.length, "logical length");
  for (let index = 0; index < expected.length; index++) {
    assertClose(actual[index]!, expected[index]!, 1e-6, `lane=${index}`);
  }
});

Deno.test("SimdFloat32Vector dispose reuses storage and rejects later access", () => {
  const before = SimdFloat32Vector.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const vector = SimdFloat32Vector.from(new Float32Array(1024));
    vector.dispose();
    vector.dispose(); // Idempotent cleanup is convenient in finally blocks.
  }
  const after = SimdFloat32Vector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "vector live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "vector live bytes");
  if (after.reservedBytes > before.reservedBytes + 4096) {
    throw new Error(
      `vector storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
  const disposed = new SimdFloat32Vector(4);
  disposed.dispose();
  let threw = false;
  try {
    disposed.toFloat32Array();
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(threw, true, "vector use after dispose");
});

Deno.test("SimdInt32Array exposes fixed storage and SIMD reductions", () => {
  using values = SimdInt32Array.from([5, -7, 11, 0, 2]);
  assertEquals(values.length, 5, "length");
  assertEquals(values.get(1), -7, "get");
  values.set(3, 13);
  assertEquals(values.sum(), 24, "sum");
  assertEquals(values.min(), -7, "min");
  assertEquals(values.max(), 13, "max");
  assertEquals(values.toInt32Array().join(","), "5,-7,11,13,2", "copy out");
});

Deno.test("SimdInt32Array performs fixed-length compound operations", () => {
  using left = SimdInt32Array.from([1, 2, 3, 4, 5]);
  using right = SimdInt32Array.from([10, 20, 30, 40, 50]);
  using equal = SimdInt32Array.from([1, 2, 3, 4, 5]);
  assertEquals(left.equals(equal), true, "equal");
  assertEquals(left.equals(right), false, "different");
  left.addAssign(right);
  assertEquals(left.toInt32Array().join(","), "11,22,33,44,55", "in-place add");
  left.fill(-3);
  assertEquals(left.sum(), -15, "fill");
});

Deno.test("SimdInt32Array preserves wide sums and validates contracts", () => {
  using values = SimdInt32Array.from([0x7fff_ffff, 0x7fff_ffff, -0x8000_0000]);
  assertEquals(values.sum(), 2_147_483_646, "i64 accumulation");
  using empty = new SimdInt32Array(0);
  assertEquals(empty.sum(), 0, "empty sum");
  let threw = false;
  try {
    empty.min();
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "empty min");
});

Deno.test("SimdInt32Array using lifecycle returns allocator storage", () => {
  const before = SimdInt32Array.allocatorStats();
  {
    using values = new SimdInt32Array(1024);
    values.fill(1);
    assertEquals(values.sum(), 1024, "live value");
  }
  const after = SimdInt32Array.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdInt32Array releases allocation when from throws", () => {
  const before = SimdInt32Array.allocatorStats();
  const values = {
    length: 4,
    get 0(): number {
      throw new Error("input failed");
    },
  } as ArrayLike<number>;
  let threw = false;
  try {
    SimdInt32Array.from(values);
  } catch (error) {
    threw = error instanceof Error && error.message === "input failed";
  }
  assertEquals(threw, true, "source error");
  const after = SimdInt32Array.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdInt32Array matches Int32Array across SIMD tails", () => {
  let state = 0x1234_5678;
  for (const length of [0, 1, 3, 4, 5, 15, 16, 17, 63, 64, 65, 1025]) {
    const values = Int32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      return state;
    });
    using actual = SimdInt32Array.from(values);
    let expectedSum = 0;
    let expectedMin = values[0];
    let expectedMax = values[0];
    for (const value of values) {
      expectedSum += value;
      if (value < expectedMin!) expectedMin = value;
      if (value > expectedMax!) expectedMax = value;
    }
    assertEquals(actual.sum(), expectedSum, `sum length=${length}`);
    if (length > 0) {
      assertEquals(actual.min(), expectedMin, `min length=${length}`);
      assertEquals(actual.max(), expectedMax, `max length=${length}`);
    }
  }
});

Deno.test("SimdMatrix2D preserves shape, indexing, and row padding", () => {
  using matrix = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  assertEquals(matrix.rows, 2, "rows");
  assertEquals(matrix.columns, 3, "columns");
  assertEquals(matrix.get(1, 2), 6, "get");
  matrix.set(0, 1, 20);
  assertEquals(matrix.toFloat32Array().join(","), "1,20,3,4,5,6", "logical copy");
});

Deno.test("SimdMatrix2D multiplies non-SIMD-aligned shapes", () => {
  using left = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix2D.from(3, 2, [7, 8, 9, 10, 11, 12]);
  using output = left.multiply(right);
  assertEquals(output.rows, 2, "output rows");
  assertEquals(output.columns, 2, "output columns");
  assertEquals(output.toFloat32Array().join(","), "58,64,139,154", "matrix product");
});

Deno.test("SimdMatrix2D compound operations ignore padding", () => {
  using left = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix2D.from(2, 3, [10, 20, 30, 40, 50, 60]);
  left.addAssign(right).scaleAssign(0.5);
  assertEquals(left.toFloat32Array().join(","), "5.5,11,16.5,22,27.5,33", "compound");
});

Deno.test("SimdMatrix2D multiplyInto matches scalar multiplication", () => {
  for (const [rows, inner, columns] of [[1, 1, 1], [3, 5, 2], [5, 4, 7]] as const) {
    const leftValues = Float32Array.from(
      { length: rows * inner },
      (_, index) => (index % 11) - 5,
    );
    const rightValues = Float32Array.from(
      { length: inner * columns },
      (_, index) => (index % 7) * 0.25 - 0.5,
    );
    using left = SimdMatrix2D.from(rows, inner, leftValues);
    using right = SimdMatrix2D.from(inner, columns, rightValues);
    using output = new SimdMatrix2D(rows, columns);
    left.multiplyInto(right, output);
    const actual = output.toFloat32Array();
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        let expected = 0;
        for (let index = 0; index < inner; index++) {
          expected += leftValues[row * inner + index]! * rightValues[index * columns + column]!;
        }
        assertClose(
          actual[row * columns + column]!,
          expected,
          Math.max(1e-5, Math.abs(expected) * 1e-5),
          `${rows}x${inner} * ${inner}x${columns} [${row},${column}]`,
        );
      }
    }
  }
});

Deno.test("SimdMatrix2D using lifecycle returns allocator storage", () => {
  const before = SimdMatrix2D.allocatorStats();
  {
    using matrix = new SimdMatrix2D(128, 128);
    matrix.fill(1);
  }
  const after = SimdMatrix2D.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SimdMatrix2D rejects an aliased multiplication output", () => {
  using matrix = SimdMatrix2D.from(2, 2, [1, 2, 3, 4]);
  let threw = false;
  try {
    matrix.multiplyInto(matrix, matrix);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "aliased output");
});

Deno.test("SimdMatrix3D preserves batch-major shape and padded indexing", () => {
  using tensor = SimdMatrix3D.from(2, 2, 3, [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
  ]);
  assertEquals(tensor.batches, 2, "batches");
  assertEquals(tensor.rows, 2, "rows");
  assertEquals(tensor.columns, 3, "columns");
  assertEquals(tensor.get(1, 1, 2), 12, "get");
  tensor.set(0, 1, 1, 50);
  assertEquals(
    tensor.toFloat32Array().join(","),
    "1,2,3,4,50,6,7,8,9,10,11,12",
    "batch-major copy",
  );
});

Deno.test("SimdMatrix3D computes an independent product for every batch", () => {
  using left = SimdMatrix3D.from(2, 2, 2, [
    1,
    2,
    3,
    4,
    2,
    0,
    1,
    2,
  ]);
  using right = SimdMatrix3D.from(2, 2, 2, [
    5,
    6,
    7,
    8,
    1,
    3,
    4,
    2,
  ]);
  using output = left.batchMultiply(right);
  assertEquals(output.batches, 2, "output batches");
  assertEquals(output.rows, 2, "output rows");
  assertEquals(output.columns, 2, "output columns");
  assertEquals(
    output.toFloat32Array().join(","),
    "19,22,43,50,2,6,9,7",
    "batched matrix product",
  );
});

Deno.test("SimdMatrix3D batchMultiplyInto matches scalar non-aligned shapes", () => {
  for (
    const [batches, rows, inner, columns] of [
      [1, 1, 1, 1],
      [3, 3, 5, 2],
      [2, 5, 4, 7],
    ] as const
  ) {
    const leftValues = Float32Array.from(
      { length: batches * rows * inner },
      (_, index) => (index % 11) - 5,
    );
    const rightValues = Float32Array.from(
      { length: batches * inner * columns },
      (_, index) => (index % 7) * 0.25 - 0.5,
    );
    using left = SimdMatrix3D.from(batches, rows, inner, leftValues);
    using right = SimdMatrix3D.from(batches, inner, columns, rightValues);
    using output = new SimdMatrix3D(batches, rows, columns);
    left.batchMultiplyInto(right, output);
    const actual = output.toFloat32Array();
    for (let batch = 0; batch < batches; batch++) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          let expected = 0;
          for (let index = 0; index < inner; index++) {
            expected += leftValues[(batch * rows + row) * inner + index]! *
              rightValues[(batch * inner + index) * columns + column]!;
          }
          assertClose(
            actual[(batch * rows + row) * columns + column]!,
            expected,
            Math.max(1e-5, Math.abs(expected) * 1e-5),
            `${batches}x${rows}x${inner} * ${batches}x${inner}x${columns}`,
          );
        }
      }
    }
  }
});

Deno.test("SimdMatrix3D compound operations ignore row padding", () => {
  using left = SimdMatrix3D.from(1, 2, 3, [1, 2, 3, 4, 5, 6]);
  using right = SimdMatrix3D.from(1, 2, 3, [10, 20, 30, 40, 50, 60]);
  left.addAssign(right).scaleAssign(0.5);
  assertEquals(left.toFloat32Array().join(","), "5.5,11,16.5,22,27.5,33", "compound");
});

Deno.test("SimdMatrix3D using lifecycle and multiplication contracts", () => {
  const before = SimdMatrix3D.allocatorStats();
  {
    using left = new SimdMatrix3D(4, 8, 8);
    using right = new SimdMatrix3D(4, 8, 8);
    left.fill(1);
    right.fill(2);
    let aliased = false;
    try {
      left.batchMultiplyInto(right, left);
    } catch (error) {
      aliased = error instanceof RangeError;
    }
    assertEquals(aliased, true, "aliased output");

    using mismatchedBatch = new SimdMatrix3D(1, 8, 8);
    let mismatched = false;
    try {
      left.batchMultiply(mismatchedBatch);
    } catch (error) {
      mismatched = error instanceof RangeError;
    }
    assertEquals(mismatched, true, "batch mismatch");
  }
  const after = SimdMatrix3D.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("BitVector defines rank and select boundary semantics", () => {
  using bits = BitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  assertEquals(bits.length, 20, "length");
  assertEquals(bits.countOnes, 7, "count ones");
  assertEquals(bits.get(0), true, "get set bit");
  assertEquals(bits.get(2), false, "get clear bit");
  assertEquals(bits.rank1(0), 0, "rank1 empty prefix");
  assertEquals(bits.rank1(1), 1, "rank1 includes bit before end");
  assertEquals(bits.rank1(8), 4, "rank1 excludes end");
  assertEquals(bits.rank1(20), 7, "rank1 full length");
  assertEquals(bits.rank0(8), 4, "rank0");
  assertEquals(bits.select1(0), 0, "first one");
  assertEquals(bits.select1(4), 8, "fifth one");
  assertEquals(bits.select1(6), 19, "last one");
  assertEquals(bits.select1(7), -1, "missing rank");
  assertEquals(bits.select1(-1), -1, "negative rank");
});

Deno.test("BitVector is the canonical frozen rank/select API", () => {
  const builder = new BitVectorBuilder(96);
  builder.insert(1).insert(32).insert(95);
  using bits = builder.freeze();
  assertEquals(bits instanceof BitVector, true, "canonical runtime type");
  assertEquals(bits.rank1(33), 2, "rank");
  assertEquals(bits.select1(2), 95, "select");
});

Deno.test("BitVector finds neighboring bits inclusively", () => {
  using bits = BitVector.from(20, [0, 4, 9, 19]);
  assertEquals(bits.next1(0), 0, "next exact");
  assertEquals(bits.next1(1), 4, "next after gap");
  assertEquals(bits.next1(19), 19, "next last");
  assertEquals(bits.next1(20), -1, "next at end");
  assertEquals(bits.prev1(19), 19, "previous exact");
  assertEquals(bits.prev1(18), 9, "previous before gap");
  assertEquals(bits.prev1(0), 0, "previous first");
  assertEquals(bits.prev1(-1), -1, "previous before start");
});

Deno.test("BitVector crosses 128-bit and 512-bit blocks", () => {
  const positions = [0, 31, 32, 127, 128, 510, 511, 512, 513, 1023, 1024, 1030];
  using bits = BitVector.from(1031, positions);
  for (let index = 0; index < positions.length; index++) {
    assertEquals(bits.rank1(positions[index]!), index, `rank before ${positions[index]}`);
    assertEquals(bits.select1(index), positions[index], `select ${index}`);
  }
  assertEquals(bits.rank1(1031), positions.length, "rank tail");
});

Deno.test("BitVectorBuilder freezes an immutable snapshot", () => {
  const builder = new BitVectorBuilder(600);
  builder.insert(1).insert(511).insert(512).insert(599).remove(1);
  using frozen = builder.freeze();
  builder.insert(1).remove(512);
  assertEquals(frozen.get(1), false, "snapshot excludes removed bit");
  assertEquals(frozen.get(512), true, "snapshot retains later mutation");
  assertEquals(frozen.toArray().join(","), "511,512,599", "frozen values");
});

Deno.test("BitVector executes rank and select queries in bulk", () => {
  using bits = BitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  const before = BitVector.allocatorStats();
  const rankOutput = new Uint32Array(6);
  assertEquals(
    bits.rank1Many(new Uint32Array([0, 1, 8, 9, 20, 20]), rankOutput),
    rankOutput,
    "rank output reuse",
  );
  assertEquals(rankOutput.join(","), "0,1,4,5,7,7", "bulk ranks");
  const selectOutput = new Int32Array(5);
  assertEquals(
    bits.select1Many(new Uint32Array([0, 4, 6, 7, 100]), selectOutput),
    selectOutput,
    "select output reuse",
  );
  assertEquals(selectOutput.join(","), "0,8,19,-1,-1", "bulk selects");
  const after = BitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bulk scratch allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bulk scratch bytes");
});

Deno.test("BitVector matches scalar randomized references", () => {
  let state = 0x6d2b_79f5;
  for (const length of [0, 1, 127, 128, 511, 512, 513, 4099]) {
    const expected: number[] = [];
    for (let position = 0; position < length; position++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 7) === 0) expected.push(position);
    }
    using bits = BitVector.from(length, expected);
    let rank = 0;
    for (let end = 0; end <= length; end++) {
      assertEquals(bits.rank1(end), rank, `rank length=${length} end=${end}`);
      if (end < length && expected[rank] === end) rank++;
    }
    for (let index = 0; index < expected.length; index++) {
      assertEquals(bits.select1(index), expected[index], `select length=${length} rank=${index}`);
    }
  }
});

Deno.test("BitVector using lifecycle returns allocator storage", () => {
  const before = BitVector.allocatorStats();
  {
    using bits = BitVector.from(1_000_000, [1, 10, 999_999]);
    assertEquals(bits.rank1(1_000_000), 3, "live rank");
  }
  const after = BitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("RoaringBitmap supports the complete Uint32 key range", () => {
  using values = RoaringBitmap.from([0, 1, 65_535, 65_536, 70_000, 0xffff_ffff]);
  assertEquals(values.size, 6, "size");
  assertEquals(values.has(0), true, "zero");
  assertEquals(values.has(65_536), true, "second container");
  assertEquals(values.has(0xffff_ffff), true, "uint32 max");
  assertEquals(values.has(2), false, "missing");
  values.insert(1).remove(70_000).remove(70_000);
  assertEquals(values.size, 5, "idempotent mutation");
  assertEquals(values.toUint32Array().join(","), "0,1,65535,65536,4294967295", "sorted copy");
});

Deno.test("RoaringBitmap is the canonical adaptive-container API", () => {
  using bitmap = RoaringBitmap.from([1, 65_536, 0xffff_ffff]);
  assertEquals(bitmap instanceof RoaringBitmap, true, "canonical runtime type");
  assertEquals(bitmap.has(65_536), true, "membership");
});

Deno.test("RoaringBitmap converts containers at the 4096 threshold", () => {
  using values = new RoaringBitmap();
  for (let value = 0; value <= 4096; value++) values.insert(value);
  assertEquals(values.size, 4097, "bitmap size");
  for (const value of [0, 1, 4095, 4096]) assertEquals(values.has(value), true, `has ${value}`);
  values.remove(4096);
  assertEquals(values.size, 4096, "array size after shrinking");
  assertEquals(values.has(4095), true, "survives bitmap to array conversion");
});

Deno.test("RoaringBitmap computes non-materializing set queries", () => {
  using left = RoaringBitmap.from([1, 2, 65_535, 65_536, 65_537, 0xffff_ffff]);
  using right = RoaringBitmap.from([2, 65_536, 70_000, 0xffff_ffff]);
  assertEquals(left.andCardinality(right), 3, "intersection cardinality");
  assertEquals(left.intersects(right), true, "intersects");
  assertClose(left.jaccard(right), 3 / 7, 1e-12, "jaccard");
  using disjoint = RoaringBitmap.from([100, 200]);
  assertEquals(left.intersects(disjoint), false, "disjoint");
  using emptyLeft = new RoaringBitmap();
  using emptyRight = new RoaringBitmap();
  assertEquals(emptyLeft.jaccard(emptyRight), 1, "empty jaccard");
});

Deno.test("RoaringBitmap andInto reuses output without aliasing", () => {
  using left = new RoaringBitmap();
  using right = new RoaringBitmap();
  for (let value = 0; value < 20_000; value++) {
    if (value % 3 === 0) left.insert(value);
    if (value % 5 === 0) right.insert(value);
  }
  using output = RoaringBitmap.from([0xffff_ffff]);
  assertEquals(left.andInto(right, output), output, "output reuse");
  assertEquals(output.size, 1_334, "intersection size");
  assertEquals(output.has(0), true, "first intersection");
  assertEquals(output.has(19_995), true, "last intersection");
  let aliased = false;
  try {
    left.andInto(right, left);
  } catch (error) {
    aliased = error instanceof RangeError;
  }
  assertEquals(aliased, true, "aliased output");
});

Deno.test("RoaringBitmap retains dense bitmap intersection results", () => {
  using left = new RoaringBitmap();
  using right = new RoaringBitmap();
  for (let value = 0; value <= 6_000; value++) left.insert(value);
  for (let value = 1_000; value <= 7_000; value++) right.insert(value);
  using output = left.and(right);
  assertEquals(output.size, 5_001, "dense intersection size");
  assertEquals(output.has(999), false, "before dense result");
  assertEquals(output.has(1_000), true, "dense result start");
  assertEquals(output.has(6_000), true, "dense result end");
  assertEquals(output.has(6_001), false, "after dense result");
  assertEquals(left.andCardinality(right), 5_001, "dense count");
});

Deno.test("RoaringBitmap emits maximal inclusive ranges", () => {
  using values = RoaringBitmap.from([
    1,
    2,
    3,
    65_535,
    65_536,
    65_537,
    100_000,
    100_002,
  ]);
  const ranges: string[] = [];
  values.forEachRange((start, end) => ranges.push(`${start}-${end}`));
  assertEquals(ranges.join(","), "1-3,65535-65537,100000-100000,100002-100002", "ranges");
});

Deno.test("RoaringBitmap matches Set on randomized operations", () => {
  using actual = new RoaringBitmap();
  const expected = new Set<number>();
  let state = 0x1234_abcd;
  for (let operation = 0; operation < 20_000; operation++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const value = operation % 3 === 0 ? state : state & 0x3ffff;
    if ((state & 8) === 0) {
      actual.insert(value);
      expected.add(value);
    } else {
      actual.remove(value);
      expected.delete(value);
    }
  }
  const sorted = Uint32Array.from(expected).sort();
  assertEquals(actual.size, expected.size, "random size");
  assertEquals(actual.toUint32Array().join(","), sorted.join(","), "random contents");
});

Deno.test("RoaringBitmap using lifecycle returns every container allocation", () => {
  const before = RoaringBitmap.allocatorStats();
  {
    using values = new RoaringBitmap();
    for (let value = 0; value < 200_000; value += 3) values.insert(value);
    assertEquals(values.has(199_998), true, "live set");
  }
  const after = RoaringBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("RoaringBitmap releases partial construction after invalid input", () => {
  const before = RoaringBitmap.allocatorStats();
  let threw = false;
  try {
    RoaringBitmap.from([1, 65_536, -1]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "invalid Uint32");
  const after = RoaringBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "partial allocations");
  assertEquals(after.liveBytes, before.liveBytes, "partial bytes");
});

Deno.test("PackedDeltaUint32List preserves monotone Uint32 values", () => {
  const values = [0, 1, 255, 256, 65_535, 0x7fff_ffff, 0xffff_ffff];
  using packed = PackedDeltaUint32List.from(values);
  assertEquals(packed.length, values.length, "length");
  for (let index = 0; index < values.length; index++) {
    assertEquals(packed.at(index), values[index], `at ${index}`);
  }
  assertEquals(packed.toUint32Array().join(","), values.join(","), "full decode");
});

Deno.test("PackedDeltaUint32List implements lower-bound and nextGEQ", () => {
  using packed = PackedDeltaUint32List.from([1, 5, 9, 100, 0xffff_ffff]);
  assertEquals(packed.lowerBound(0), 0, "before first");
  assertEquals(packed.lowerBound(1), 0, "exact first");
  assertEquals(packed.lowerBound(6), 2, "between");
  assertEquals(packed.lowerBound(0xffff_ffff), 4, "exact max");
  assertEquals(packed.nextGEQ(6), 9, "next value");
  assertEquals(packed.nextGEQ(0xffff_ffff), 0xffff_ffff, "next max");
  assertEquals(packed.nextGEQ(101), 0xffff_ffff, "next wide delta");
});

Deno.test("PackedDeltaUint32List decodes ranges into reusable output", () => {
  const values = Uint32Array.from({ length: 300 }, (_, index) => index * index + index);
  using packed = PackedDeltaUint32List.from(values);
  const output = new Uint32Array(17);
  assertEquals(packed.decodeInto(127, output), 17, "decoded count");
  assertEquals(output.join(","), values.slice(127, 144).join(","), "128-boundary decode");
  assertEquals(packed.decodeInto(295, output), 5, "tail count");
  assertEquals(output.slice(0, 5).join(","), values.slice(295).join(","), "tail values");
});

Deno.test("PackedDeltaUint32List intersects without full materialization", () => {
  using left = PackedDeltaUint32List.from([1, 3, 7, 9, 100, 1_000, 0xffff_ffff]);
  using right = PackedDeltaUint32List.from([0, 3, 4, 9, 1_000, 2_000, 0xffff_ffff]);
  const output = new Uint32Array(8);
  assertEquals(left.intersectInto(right, output), 4, "intersection count");
  assertEquals(output.slice(0, 4).join(","), "3,9,1000,4294967295", "intersection values");
  const truncated = new Uint32Array(2);
  assertEquals(left.intersectInto(right, truncated), 2, "bounded intersection count");
  assertEquals(truncated.join(","), "3,9", "bounded intersection values");
});

Deno.test("PackedDeltaUint32List intersection matches randomized sorted arrays", () => {
  let state = 0x2468_ace0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  for (let round = 0; round < 32; round++) {
    const leftValues: number[] = [];
    const rightValues: number[] = [];
    for (let value = 0; value < 2_000; value++) {
      if ((random() & 7) === 0) leftValues.push(value * 65_537);
      if ((random() & 15) === 0) rightValues.push(value * 65_537);
    }
    using left = PackedDeltaUint32List.from(leftValues);
    using right = PackedDeltaUint32List.from(rightValues);
    const expected = leftValues.filter((value) => rightValues.includes(value));
    const output = new Uint32Array(Math.max(1, expected.length));
    const count = left.intersectInto(right, output);
    assertEquals(count, expected.length, `random intersection count ${round}`);
    assertEquals(
      output.slice(0, count).join(","),
      expected.join(","),
      `random intersection values ${round}`,
    );
  }
});

Deno.test("PackedDeltaUint32ListBuilder freezes strict snapshots", () => {
  const builder = new PackedDeltaUint32ListBuilder();
  builder.append(10).append(20).append(30);
  using first = builder.freeze();
  builder.append(40);
  using second = builder.freeze();
  assertEquals(first.toUint32Array().join(","), "10,20,30", "first snapshot");
  assertEquals(second.toUint32Array().join(","), "10,20,30,40", "second snapshot");
  let duplicate = false;
  try {
    builder.append(40);
  } catch (error) {
    duplicate = error instanceof RangeError;
  }
  assertEquals(duplicate, true, "strictly increasing input");
});

Deno.test("PackedDeltaUint32List matches randomized monotone values", () => {
  const values: number[] = [];
  let state = 0x1357_9bdf;
  let value = 0;
  for (let index = 0; index < 2_000; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const delta = (state & 0x3ff) + 1;
    if (value + delta > 0xffff_ffff) break;
    value += delta;
    values.push(value);
  }
  using packed = PackedDeltaUint32List.from(values);
  for (let index = 0; index < values.length; index += 17) {
    assertEquals(packed.at(index), values[index], `random at ${index}`);
    assertEquals(packed.lowerBound(values[index]!), index, `random lower bound ${index}`);
  }
  assertEquals(packed.toUint32Array().join(","), values.join(","), "random decode");
});

Deno.test("PackedDeltaUint32List using lifecycle returns compressed allocations", () => {
  const before = PackedDeltaUint32List.allocatorStats();
  {
    using packed = PackedDeltaUint32List.from(
      Uint32Array.from({ length: 10_000 }, (_, index) => index * 3),
    );
    assertEquals(packed.at(9_999), 29_997, "live packed value");
    if (packed.compressedBytes >= packed.length * 4) {
      throw new Error(`small deltas did not compress: ${packed.compressedBytes}`);
    }
  }
  const after = PackedDeltaUint32List.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("FlatHashSetU32 supports Uint32 keys, tombstones, and growth", () => {
  using set = new FlatHashSetU32(16);
  set.insert(0).insert(0xffff_ffff).insert(42).insert(42);
  assertEquals(set.size, 3, "deduplicated size");
  assertEquals(set.has(0), true, "zero key");
  assertEquals(set.has(0xffff_ffff), true, "maximum key");
  assertEquals(set.delete(42), true, "delete existing");
  assertEquals(set.delete(42), false, "delete missing");
  for (let key = 1; key <= 2_000; key++) set.insert(Math.imul(key, 65_537) >>> 0);
  assertEquals(set.size, 2_002, "size after growth");
  for (let key = 1; key <= 2_000; key += 37) {
    assertEquals(set.has(Math.imul(key, 65_537) >>> 0), true, `grown key ${key}`);
  }
  if (set.capacity < 2_002) throw new Error(`capacity did not grow: ${set.capacity}`);
});

Deno.test("FlatHashSetU32 batches inserts and reusable lookups", () => {
  using set = FlatHashSetU32.from([1, 3, 5]);
  set.insertMany(new Uint32Array([5, 7, 9, 0xffff_ffff]));
  const queries = new Uint32Array([0, 1, 7, 8, 9, 0xffff_ffff]);
  const present = new Uint8Array(queries.length);
  assertEquals(set.lookupMany(queries, present), 4, "bulk hit count");
  assertEquals(present.join(","), "0,1,1,0,1,1", "bulk presence");
});

Deno.test("FlatHashMapU32U32 stores and overwrites the complete Uint32 domain", () => {
  using map = new FlatHashMapU32U32();
  map.set(0, 0xffff_ffff).set(0xffff_ffff, 0).set(42, 10).set(42, 11);
  assertEquals(map.size, 3, "map size");
  assertEquals(map.get(0), 0xffff_ffff, "maximum value");
  assertEquals(map.get(0xffff_ffff), 0, "zero value");
  assertEquals(map.get(42), 11, "overwrite");
  assertEquals(map.get(7), undefined, "missing value");
  assertEquals(map.delete(42), true, "map delete");
  assertEquals(map.has(42), false, "deleted key");
});

Deno.test("FlatHashMapU32U32 batches inserts and reusable lookups", () => {
  using map = new FlatHashMapU32U32(16);
  const keys = Uint32Array.from({ length: 2_000 }, (_, index) => Math.imul(index, 2_654_435_761));
  const values = Uint32Array.from({ length: keys.length }, (_, index) => index * 3);
  map.insertMany(keys, values);
  const queries = new Uint32Array([keys[0]!, keys[999]!, 123, keys[1_999]!]);
  const output = new Uint32Array(queries.length);
  const present = new Uint8Array(queries.length);
  assertEquals(map.lookupMany(queries, output, present), 3, "map bulk hits");
  assertEquals(present.join(","), "1,1,0,1", "map bulk presence");
  assertEquals(output[0], 0, "map first value");
  assertEquals(output[1], 2_997, "map middle value");
  assertEquals(output[3], 5_997, "map last value");
});

Deno.test("FlatHash tables match native references and release grown storage", () => {
  const setBefore = FlatHashSetU32.allocatorStats();
  const mapBefore = FlatHashMapU32U32.allocatorStats();
  {
    using set = new FlatHashSetU32();
    using map = new FlatHashMapU32U32();
    const referenceSet = new Set<number>();
    const referenceMap = new Map<number, number>();
    let state = 0xdead_beef;
    for (let index = 0; index < 10_000; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const key = state;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = state;
      set.insert(key);
      map.set(key, value);
      referenceSet.add(key);
      referenceMap.set(key, value);
      if ((index & 7) === 0) {
        set.delete(key);
        map.delete(key);
        referenceSet.delete(key);
        referenceMap.delete(key);
      }
    }
    assertEquals(set.size, referenceSet.size, "random set size");
    assertEquals(map.size, referenceMap.size, "random map size");
    for (const key of referenceSet) assertEquals(set.has(key), true, `random set ${key}`);
    for (const [key, value] of referenceMap) {
      assertEquals(map.get(key), value, `random map ${key}`);
    }
  }
  const setAfter = FlatHashSetU32.allocatorStats();
  const mapAfter = FlatHashMapU32U32.allocatorStats();
  assertEquals(setAfter.liveAllocations, setBefore.liveAllocations, "set allocations");
  assertEquals(setAfter.liveBytes, setBefore.liveBytes, "set bytes");
  assertEquals(mapAfter.liveAllocations, mapBefore.liveAllocations, "map allocations");
  assertEquals(mapAfter.liveBytes, mapBefore.liveBytes, "map bytes");
});

Deno.test("FlatHash allocator reaches a reuse plateau after repeated growth", () => {
  const exercise = () => {
    using set = new FlatHashSetU32();
    using map = new FlatHashMapU32U32();
    const keys = Uint32Array.from({ length: 20_000 }, (_, index) => Math.imul(index, 0x9e37_79b1));
    const values = Uint32Array.from(keys, (key) => key ^ 0xa5a5_a5a5);
    set.insertMany(keys);
    map.insertMany(keys, values);
    set.clear().insertMany(keys);
    map.clear().insertMany(keys, values);
  };
  exercise();
  const plateau = FlatHashSetU32.allocatorStats();
  exercise();
  const repeated = FlatHashSetU32.allocatorStats();
  assertEquals(repeated.liveAllocations, 0, "plateau live allocations");
  assertEquals(repeated.liveBytes, 0, "plateau live bytes");
  assertEquals(repeated.reservedBytes, plateau.reservedBytes, "plateau reserved bytes");
});

Deno.test("FingerprintGroup16 returns SwissTable control masks", () => {
  using group = FingerprintGroup16.from(
    Uint8Array.of(7, 1, 7, 0x80, 0xfe, 7, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
  );
  assertEquals(group.matchMask(7), 0b0000_0100_0010_0101, "fingerprint mask");
  assertEquals(group.emptyMask(), 1 << 3, "empty mask");
  assertEquals(group.deletedMask(), 1 << 4, "deleted mask");
  assertEquals(group.availableMask(), (1 << 3) | (1 << 4), "available mask");
  assertEquals(group.firstMatch(7), 0, "first match");
  assertEquals(group.firstMatch(127), -1, "missing match");
});

Deno.test("FingerprintGroup16 batches probes into reusable Uint16 output", () => {
  using group = FingerprintGroup16.from(
    Uint8Array.from({ length: 16 }, (_, index) => index & 3),
  );
  const output = new Uint16Array(6);
  group.matchMany(Uint8Array.of(0, 1, 2, 3, 4, 127), output);
  assertEquals(output.join(","), "4369,8738,17476,34952,0,0", "batch masks");
});

Deno.test("FingerprintGroup16 validates controls and releases using-owned storage", () => {
  const before = FingerprintGroup16.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using group = FingerprintGroup16.empty();
    assertEquals(group.emptyMask(), 0xffff, "all empty");
  }
  const after = FingerprintGroup16.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("FingerprintTable16 stores and probes multiple aligned groups", () => {
  using table = new FingerprintTable16(64);
  table.setControl(1, 7).setControl(18, 7).setControl(19, 3).setControl(33, 7);
  assertEquals(table.matchMask(0, 7), 1 << 1, "group zero");
  assertEquals(table.matchMask(1, 7), 1 << 2, "group one");
  assertEquals(table.matchMask(2, 7), 1 << 1, "group two");
  assertEquals(table.emptyMask(1), 0xffff ^ ((1 << 2) | (1 << 3)), "group empties");
  table.delete(18);
  assertEquals(table.deletedMask(1), 1 << 2, "deleted lane");
});

Deno.test("FingerprintTable16 batches primary group and fingerprint masks", () => {
  using table = new FingerprintTable16(64);
  table.setControl(1, 7).setControl(18, 7).setControl(19, 3).setControl(33, 7);
  const hashes = Uint32Array.of((7 << 25) | 1, (7 << 25) | 18, (3 << 25) | 19, (9 << 25) | 33);
  const groups = new Uint32Array(hashes.length);
  const matches = new Uint16Array(hashes.length);
  const empty = new Uint16Array(hashes.length);
  const deleted = new Uint16Array(hashes.length);
  table.probeMany(hashes, groups, matches, empty, deleted);
  assertEquals(groups.join(","), "0,16,16,32", "group offsets");
  assertEquals(matches.join(","), "2,4,8,0", "candidate masks");
  assertEquals(deleted.join(","), "0,0,0,0", "deleted masks");
  assertEquals(empty[0], 0xfffd, "empty group zero");
});

function fixed16(seed: number): Uint8Array {
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, seed, true);
  let state = seed >>> 0;
  for (let index = 4; index < 16; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    key[index] = state >>> 24;
  }
  return key;
}

Deno.test("FlatHashMapFixed16U32 compares complete 16-byte keys", () => {
  using map = new FlatHashMapFixed16U32();
  const first = fixed16(1);
  const second = first.slice();
  second[15] ^= 1;
  map.set(first, 10).set(second, 20).set(first, 30);
  assertEquals(map.size, 2, "map size");
  assertEquals(map.get(first), 30, "overwrite");
  assertEquals(map.get(second), 20, "tail distinguishes key");
  assertEquals(map.get(fixed16(99)), undefined, "missing");
  assertEquals(map.delete(first), true, "delete existing");
  assertEquals(map.has(first), false, "deleted missing");
});

Deno.test("FlatHashMapFixed16U32 batches insertion and lookup", () => {
  const count = 2_000;
  const keys = new Uint8Array(count * 16);
  const values = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    keys.set(fixed16(index), index * 16);
    values[index] = index * 3;
  }
  using map = new FlatHashMapFixed16U32(16);
  map.insertMany(keys, values);
  const queries = new Uint8Array(4 * 16);
  queries.set(keys.subarray(0, 16), 0);
  queries.set(keys.subarray(999 * 16, 1_000 * 16), 16);
  queries.set(fixed16(99_999), 32);
  queries.set(keys.subarray(1_999 * 16, 2_000 * 16), 48);
  const output = new Uint32Array(4);
  const present = new Uint8Array(4);
  assertEquals(map.lookupMany(queries, output, present), 3, "bulk hits");
  assertEquals(present.join(","), "1,1,0,1", "presence");
  assertEquals(output.join(","), "0,2997,0,5997", "values");
});

Deno.test("FlatHashSetFixed16 derives set operations from the fixed-key table", () => {
  using set = FlatHashSetFixed16.from([fixed16(1), fixed16(2), fixed16(1)]);
  assertEquals(set.size, 2, "deduplicated size");
  assertEquals(set.has(fixed16(2)), true, "present key");
  assertEquals(set.delete(fixed16(2)), true, "delete");
  assertEquals(set.has(fixed16(2)), false, "deleted key");
  const queries = new Uint8Array(3 * 16);
  queries.set(fixed16(1), 0);
  queries.set(fixed16(2), 16);
  queries.set(fixed16(3), 32);
  const present = new Uint8Array(3);
  assertEquals(set.lookupMany(queries, present), 1, "set batch hits");
  assertEquals(present.join(","), "1,0,0", "set batch presence");
});

Deno.test("fixed16 hash tables release grown storage with using", () => {
  const before = FlatHashMapFixed16U32.allocatorStats();
  {
    using map = new FlatHashMapFixed16U32();
    for (let index = 0; index < 5_000; index++) map.set(fixed16(index), index);
    assertEquals(map.size, 5_000, "grown size");
  }
  const after = FlatHashMapFixed16U32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

function byteKey(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

Deno.test("ByteKeyFlatHashMapU32 distinguishes arbitrary byte keys", () => {
  using map = new ByteKeyFlatHashMapU32();
  const prefix = new Uint8Array(33).fill(0x61);
  const left = prefix.slice();
  const right = prefix.slice();
  right[32] = 0x62;
  map.set(new Uint8Array(), 1).set(byteKey(0, 1, 0, 2), 2).set(left, 3).set(right, 4);
  map.set(left, 30);
  assertEquals(map.size, 4, "map size");
  assertEquals(map.get(new Uint8Array()), 1, "empty key");
  assertEquals(map.get(byteKey(0, 1, 0, 2)), 2, "embedded zeros");
  assertEquals(map.get(left), 30, "overwrite");
  assertEquals(map.get(right), 4, "tail distinguishes key");
  assertEquals(map.get(byteKey(9)), undefined, "missing");
});

Deno.test("ByteKeyFlatHashMapU32 batches concatenated keys with offsets", () => {
  const keys = byteKey(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const offsets = Uint32Array.of(0, 0, 1, 4, 9);
  const values = Uint32Array.of(10, 20, 30, 40);
  using map = new ByteKeyFlatHashMapU32(16);
  map.insertMany(keys, offsets, values);
  const queries = byteKey(2, 3, 4, 99, 1, 5, 6, 7, 8, 9);
  const queryOffsets = Uint32Array.of(0, 3, 4, 5, 10);
  const output = new Uint32Array(4);
  const present = new Uint8Array(4);
  assertEquals(map.lookupMany(queries, queryOffsets, output, present), 3, "bulk hits");
  assertEquals(present.join(","), "1,0,1,1", "bulk presence");
  assertEquals(output.join(","), "30,0,20,40", "bulk values");
});

Deno.test("ByteKeyFlatHashMapU32 grows, deletes, clears, and releases using-owned storage", () => {
  const before = ByteKeyFlatHashMapU32.allocatorStats();
  {
    using map = new ByteKeyFlatHashMapU32(16);
    for (let index = 0; index < 5_000; index++) {
      const key = new Uint8Array(12);
      new DataView(key.buffer).setUint32(0, index, true);
      key.fill(index & 0xff, 4);
      map.set(key, index);
    }
    assertEquals(map.size, 5_000, "grown size");
    const key = new Uint8Array(12);
    new DataView(key.buffer).setUint32(0, 4_999, true);
    key.fill(4_999 & 0xff, 4);
    assertEquals(map.get(key), 4_999, "grown lookup");
    assertEquals(map.delete(key), true, "delete existing");
    assertEquals(map.has(key), false, "deleted missing");
    map.clear();
    assertEquals(map.size, 0, "clear size");
  }
  const after = ByteKeyFlatHashMapU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("ByteKeyFlatHashMapU32 matches Map for randomized variable-length batches", () => {
  let state = 0x8bad_f00d;
  const chunks: Uint8Array[] = [];
  const offsets = new Uint32Array(2_001);
  const values = new Uint32Array(2_000);
  const expected = new Map<string, number>();
  let byteLength = 0;
  for (let index = 0; index < values.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const key = new Uint8Array(state % 65);
    for (let byte = 0; byte < key.length; byte++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      key[byte] = state >>> 24;
    }
    chunks.push(key);
    byteLength += key.length;
    offsets[index + 1] = byteLength;
    values[index] = Math.imul(index, 17) >>> 0;
    expected.set(Array.from(key).join(","), values[index]!);
  }
  const bytes = new Uint8Array(byteLength);
  let cursor = 0;
  for (const key of chunks) {
    bytes.set(key, cursor);
    cursor += key.length;
  }
  using map = new ByteKeyFlatHashMapU32(16);
  map.insertMany(bytes, offsets, values);
  assertEquals(map.size, expected.size, "deduplicated randomized size");
  const output = new Uint32Array(values.length);
  const present = new Uint8Array(values.length);
  assertEquals(map.lookupMany(bytes, offsets, output, present), values.length, "all batch hits");
  for (let index = 0; index < values.length; index++) {
    assertEquals(present[index], 1, `present ${index}`);
    assertEquals(
      output[index],
      expected.get(Array.from(chunks[index]!).join(",")),
      `value ${index}`,
    );
  }
});

Deno.test("BitSlicedColumnU8 scans equality and unsigned ranges", () => {
  using column = BitSlicedColumnU8.from(new Uint8Array([0, 1, 2, 3, 7, 15, 16, 31]), 5);
  using mask = new BitSliceMask(column.length);
  column.eq(3, mask);
  assertEquals(mask.toIndices().join(","), "3", "eq");
  column.lt(7, mask);
  assertEquals(mask.toIndices().join(","), "0,1,2,3", "lt");
  column.between(3, 16, mask);
  assertEquals(mask.toIndices().join(","), "3,4,5,6", "inclusive between");
  assertEquals(column.get(7), 31, "point access");
});

Deno.test("BitSlicedColumnU8 keeps nulls separate from encoded values", () => {
  const values = new Uint8Array([0, 0, 1, 2, 0]);
  const validity = new Uint8Array([1, 0, 1, 1, 0]);
  using column = BitSlicedColumnU8.from(values, 2, validity);
  using mask = new BitSliceMask(values.length);
  column.eq(0, mask);
  assertEquals(mask.toIndices().join(","), "0", "null is not zero");
  assertEquals(column.get(1), undefined, "null point access");
  column.lt(3, mask);
  assertEquals(mask.toIndices().join(","), "0,2,3", "predicates exclude nulls");
});

Deno.test("BitSliceMask composes resident predicate results", () => {
  using left = BitSlicedColumnU8.from(new Uint8Array([1, 4, 7, 10, 13, 16]), 5);
  using right = BitSlicedColumnU8.from(new Uint8Array([0, 1, 0, 1, 0, 1]), 1);
  using range = new BitSliceMask(left.length);
  using active = new BitSliceMask(left.length);
  left.between(4, 13, range);
  right.eq(1, active);
  range.andAssign(active);
  assertEquals(range.toIndices().join(","), "1,3", "and composition");
  assertEquals(range.countOnes(), 2, "composed cardinality");
});

Deno.test("BitSlicedColumnU8 matches scalar scans across SIMD tails", () => {
  let state = 0x1020_3040;
  for (const length of [0, 1, 31, 32, 33, 127, 128, 129, 1_003]) {
    const values = Uint8Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state & 31;
    });
    using column = BitSlicedColumnU8.from(values, 5);
    using mask = new BitSliceMask(length);
    for (const query of [0, 1, 7, 16, 31, 32]) {
      column.eq(query, mask);
      const eq = Array.from(values.entries()).filter(([, value]) => value === query).map(([i]) =>
        i
      );
      assertEquals(mask.toIndices().join(","), eq.join(","), `eq ${length}/${query}`);
      column.lt(query, mask);
      const lt = Array.from(values.entries()).filter(([, value]) => value < query).map(([i]) => i);
      assertEquals(mask.toIndices().join(","), lt.join(","), `lt ${length}/${query}`);
    }
  }
});

Deno.test("BitSlicedColumn and masks release using-owned allocations", () => {
  const before = BitSlicedColumnU8.allocatorStats();
  {
    using column = BitSlicedColumnU8.from(
      Uint8Array.from({ length: 10_000 }, (_, index) => index & 15),
      4,
    );
    using mask = new BitSliceMask(column.length);
    column.eq(7, mask);
    assertEquals(mask.countOnes(), 625, "live cardinality");
  }
  const after = BitSlicedColumnU8.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bit-sliced allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bit-sliced bytes");
});

Deno.test("DenseBitmap handles boundaries and set algebra", () => {
  const left = DenseBitmap.from(130, [0, 31, 32, 63, 64, 127, 129]);
  const right = DenseBitmap.from(130, [1, 31, 63, 65, 127]);
  assertEquals(left.has(129), true, "last bit");
  assertEquals(left.has(128), false, "unset bit");
  assertEquals(left.countOnes(), 7, "left cardinality");
  assertEquals(left.intersectionCount(right), 3, "intersection cardinality");
  assertEquals(left.isDisjoint(right), false, "overlap");

  const intersection = left.clone().intersectWith(right);
  assertEquals(intersection.toArray().join(","), "31,63,127", "intersection");
  const union = left.clone().unionWith(right);
  assertEquals(union.toArray().join(","), "0,1,31,32,63,64,65,127,129", "union");
  const difference = left.clone().differenceWith(right);
  assertEquals(difference.toArray().join(","), "0,32,64,129", "difference");
  const symmetric = left.clone().symmetricDifferenceWith(right);
  assertEquals(symmetric.toArray().join(","), "0,1,32,64,65,129", "symmetric difference");
});

Deno.test("Bitmap and DenseBitmap expose growable and fixed-universe contracts", () => {
  using growable = Bitmap.from([1, 130]);
  growable.insert(10_000);
  assertEquals(growable.has(10_000), true, "growable bitmap");

  using left = DenseBitmap.from(256, [1, 3, 130]);
  using right = DenseBitmap.from(256, [3, 4, 130]);
  left.intersectWith(right);
  assertEquals(left.toArray().join(","), "3,130", "fixed dense intersection");
});

Deno.test("DenseBitmap validates capacity and ignores padded tail bits", () => {
  const bits = new DenseBitmap(33).insert(32);
  assertEquals(bits.countOnes(), 1, "tail cardinality");
  assertEquals(bits.toArray().join(","), "32", "tail enumeration");
  let threw = false;
  try {
    bits.insert(33);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "out of bounds");
});

Deno.test("DenseBitmap storage remains intact across scratch-memory kernels", () => {
  const bits = DenseBitmap.from(1024, [0, 511, 1023]);
  const input = new Uint8Array(4096).fill(0x61);
  assertEquals(findByte(input, 0x7a), -1, "scratch scan");
  assertEquals(bits.toArray().join(","), "0,511,1023", "persistent storage");

  // Allocate after scratch use as well, since the regions grow independently.
  const later = DenseBitmap.from(65_537, [65_536]);
  assertEquals(later.countOnes(), 1, "allocation after scratch");
});

Deno.test("DenseBitmap SIMD operations match Set on randomized inputs", () => {
  let state = 0x1234_5678;
  for (const capacity of [0, 1, 31, 32, 33, 127, 128, 129, 4097]) {
    const leftSet = new Set<number>();
    const rightSet = new Set<number>();
    for (let index = 0; index < capacity; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 3) === 0) leftSet.add(index);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 7) === 0) rightSet.add(index);
    }
    const left = DenseBitmap.from(capacity, leftSet);
    const right = DenseBitmap.from(capacity, rightSet);
    const expectedUnion = new Set([...leftSet, ...rightSet]);
    const expectedIntersection = [...leftSet].filter((bit) => rightSet.has(bit));
    assertEquals(left.countOnes(), leftSet.size, `count capacity=${capacity}`);
    assertEquals(
      left.intersectionCount(right),
      expectedIntersection.length,
      `and count=${capacity}`,
    );
    assertEquals(
      left.clone().unionWith(right).toArray().join(","),
      [...expectedUnion].sort((a, b) => a - b).join(","),
      `union capacity=${capacity}`,
    );
  }
});

Deno.test("DenseBitmap dispose reuses storage and reports allocator state", () => {
  const before = DenseBitmap.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    DenseBitmap.from(4096, [0, 4095]).dispose();
  }
  const after = DenseBitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bitset live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bitset live bytes");
  if (after.reservedBytes > before.reservedBytes + 512) {
    throw new Error(
      `bitset storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
  const disposed = new DenseBitmap(64);
  disposed.dispose();
  let threw = false;
  try {
    disposed.countOnes();
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(threw, true, "bitset use after dispose");
});

Deno.test("BitMatrix stores dense rows and exposes non-owning row views", () => {
  using matrix = new BitMatrix(3, 130);
  matrix.set(0, 0).set(0, 129).set(2, 64);
  assertEquals(matrix.has(0, 0), true, "first bit");
  assertEquals(matrix.has(0, 129), true, "tail bit");
  assertEquals(matrix.has(1, 0), false, "empty row");
  assertEquals(matrix.row(0).countOnes(), 2, "row count");
  assertEquals(matrix.row(0).toArray().join(","), "0,129", "row values");
  matrix.set(0, 129, false);
  assertEquals(matrix.row(0).toArray().join(","), "0", "row mutation");
});

Deno.test("BitMatrix transposes non-aligned rectangular matrices", () => {
  using matrix = BitMatrix.fromEdges(3, 5, [[0, 1], [0, 4], [2, 0], [2, 4]]);
  using transposed = matrix.transpose();
  assertEquals(transposed.rows, 5, "transposed rows");
  assertEquals(transposed.columns, 3, "transposed columns");
  assertEquals(transposed.row(0).toArray().join(","), "2", "column zero");
  assertEquals(transposed.row(4).toArray().join(","), "0,2", "column four");
});

Deno.test("BitMatrix multiplies over the Boolean semiring", () => {
  using left = BitMatrix.fromEdges(3, 4, [[0, 0], [0, 2], [1, 1], [2, 3]]);
  using right = BitMatrix.fromEdges(4, 3, [[0, 1], [1, 0], [2, 1], [2, 2], [3, 2]]);
  using product = left.multiply(right);
  assertEquals(product.row(0).toArray().join(","), "1,2", "product row zero");
  assertEquals(product.row(1).toArray().join(","), "0", "product row one");
  assertEquals(product.row(2).toArray().join(","), "2", "product row two");
});

Deno.test("BitMatrix multiply matches scalar rectangular matrices across SIMD tails", () => {
  let state = 0x55aa_1234;
  for (const [rows, shared, columns] of [[1, 1, 1], [3, 33, 5], [7, 129, 11]]) {
    const leftEdges: Array<readonly [number, number]> = [];
    const rightEdges: Array<readonly [number, number]> = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < shared; column++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        if ((state & 15) === 0) leftEdges.push([row, column]);
      }
    }
    for (let row = 0; row < shared; row++) {
      for (let column = 0; column < columns; column++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        if ((state & 15) === 0) rightEdges.push([row, column]);
      }
    }
    using left = BitMatrix.fromEdges(rows, shared, leftEdges);
    using right = BitMatrix.fromEdges(shared, columns, rightEdges);
    using product = left.multiply(right);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        let expected = false;
        for (let inner = 0; inner < shared; inner++) {
          if (left.has(row, inner) && right.has(inner, column)) {
            expected = true;
            break;
          }
        }
        assertEquals(product.has(row, column), expected, `${rows}x${shared}x${columns}`);
      }
    }
  }
});

Deno.test("BitMatrix using lifecycle returns storage and invalidates views", () => {
  const before = BitMatrix.allocatorStats();
  let view: ReturnType<BitMatrix["row"]>;
  {
    using matrix = BitMatrix.fromEdges(128, 128, [[0, 0], [127, 127]]);
    view = matrix.row(127);
    assertEquals(view.countOnes(), 1, "live view");
  }
  let disposed = false;
  try {
    view!.countOnes();
  } catch (error) {
    disposed = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(disposed, true, "view follows parent lifetime");
  const after = BitMatrix.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("Bitmap grows on insertion and preserves existing bits", () => {
  using bits = Bitmap.from([0, 31, 32, 129, 65_536]);
  assertEquals(bits.has(65_536), true, "grown bit");
  assertEquals(bits.has(1_000_000), false, "membership outside allocated capacity");
  assertEquals(bits.countOnes(), 5, "cardinality after growth");
  assertEquals(bits.toArray().join(","), "0,31,32,129,65536", "ordered values");

  bits.remove(1_000_000).remove(32);
  assertEquals(bits.toArray().join(","), "0,31,129,65536", "out-of-range removal is a no-op");
});

Deno.test("Bitmap algebra accepts different capacities", () => {
  using small = Bitmap.from([1, 31, 130]);
  using large = Bitmap.from([31, 129, 65_536]);
  using union = small.clone().unionWith(large);
  using intersection = small.clone().intersectWith(large);
  using reverseIntersection = large.clone().intersectWith(small);
  using difference = large.clone().differenceWith(small);
  using symmetric = small.clone().symmetricDifferenceWith(large);

  assertEquals(union.toArray().join(","), "1,31,129,130,65536", "dynamic union");
  assertEquals(intersection.toArray().join(","), "31", "dynamic intersection");
  assertEquals(reverseIntersection.toArray().join(","), "31", "dynamic reverse intersection");
  assertEquals(difference.toArray().join(","), "129,65536", "dynamic difference");
  assertEquals(symmetric.toArray().join(","), "1,129,130,65536", "dynamic xor");
  assertEquals(small.intersectionCount(large), 1, "dynamic intersection count");
});

Deno.test("Bitmap using cleanup returns all resized allocations", () => {
  const before = Bitmap.allocatorStats();
  {
    using bits = new Bitmap();
    for (const bit of [0, 128, 4096, 65_536]) bits.insert(bit);
  }
  const after = Bitmap.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "dynamic bitset allocations");
  assertEquals(after.liveBytes, before.liveBytes, "dynamic bitset bytes");
});

Deno.test("WaveletMatrixUint32 supports access, rank, and select", () => {
  const values = Uint32Array.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  using matrix = WaveletMatrixUint32.from(values);
  assertEquals(matrix.length, values.length, "wavelet length");
  for (let index = 0; index < values.length; index++) {
    assertEquals(matrix.access(index), values[index], `wavelet access ${index}`);
  }
  assertEquals(matrix.rank(1, 4), 2, "rank [0,end)");
  assertEquals(matrix.rank(5, values.length), 2, "rank duplicate");
  assertEquals(matrix.select(1, 0), 1, "first one");
  assertEquals(matrix.select(1, 1), 3, "second one");
  assertEquals(matrix.select(1, 2), -1, "missing occurrence");
});

Deno.test("WaveletMatrixUint8 specializes wavelet queries to the byte alphabet", () => {
  using matrix = WaveletMatrixUint8.from(Uint8Array.of(98, 97, 110, 97, 110, 97, 0, 255));
  assertEquals(matrix.length, 8, "length");
  assertEquals(matrix.levels, 8, "byte levels");
  assertEquals(matrix.access(3), 97, "access");
  assertEquals(matrix.rank(97, 6), 3, "rank");
  assertEquals(matrix.select(110, 1), 4, "select");
  assertEquals(matrix.rangeFreq(0, 8, 97, 111), 6, "range frequency");
  assertEquals(matrix.quantile(0, 8, 0), 0, "quantile");
  assertEquals(matrix.predecessor(0, 8, 98), 97, "predecessor");
});

Deno.test("WaveletMatrixUint8 batches byte access, rank, and quantile", () => {
  using matrix = WaveletMatrixUint8.from(Uint8Array.of(9, 1, 7, 1, 5, 1, 3));
  assertEquals(matrix.accessMany(Uint32Array.of(6, 0, 3)).join(","), "3,9,1", "accessMany");
  assertEquals(
    matrix.rankMany(Uint8Array.of(1, 7, 9), Uint32Array.of(7, 4, 1)).join(","),
    "3,1,1",
    "rankMany",
  );
  assertEquals(
    matrix.quantileMany(
      Uint32Array.of(0, 1),
      Uint32Array.of(7, 6),
      Uint32Array.of(3, 2),
    ).join(","),
    "3,1",
    "quantileMany",
  );
});

Deno.test("WaveletMatrixUint8 using lifecycle returns allocator storage", () => {
  const before = WaveletMatrixUint8.allocatorStats();
  {
    using matrix = WaveletMatrixUint8.from(new Uint8Array(100_000));
    assertEquals(matrix.rank(0, matrix.length), matrix.length, "resident query");
  }
  const after = WaveletMatrixUint8.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("WaveletMatrixUint8 matches scalar randomized byte queries", () => {
  let state = 0x1234_abcd;
  const values = Uint8Array.from({ length: 2_057 }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state >>> 24;
  });
  using matrix = WaveletMatrixUint8.from(values);
  for (let query = 0; query < 500; query++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const left = state % values.length;
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const right = left + (state % (values.length - left + 1));
    const value = state & 0xff;
    let rank = 0;
    for (let index = 0; index < right; index++) rank += Number(values[index] === value);
    assertEquals(matrix.rank(value, right), rank, `rank query=${query}`);
    if (right > left) {
      const sorted = values.slice(left, right).sort();
      const kth = state % sorted.length;
      assertEquals(matrix.quantile(left, right, kth), sorted[kth], `quantile query=${query}`);
    }
  }
});

Deno.test("FmIndexBytes counts overlapping arbitrary-byte patterns", () => {
  const encoder = new TextEncoder();
  using index = FmIndexBytes.from(encoder.encode("banana"));
  assertEquals(index.length, 6, "text length");
  assertEquals(index.count(encoder.encode("ana")), 2, "overlapping ana");
  assertEquals(index.count(encoder.encode("na")), 2, "na");
  assertEquals(index.count(encoder.encode("banana")), 1, "whole text");
  assertEquals(index.count(encoder.encode("x")), 0, "missing");
  assertEquals(index.count(new Uint8Array()), 7, "empty pattern suffixes");
});

Deno.test("FmIndexBytes countMany amortizes the Wasm boundary", () => {
  const text = Uint8Array.of(0, 255, 0, 1, 0, 255, 0);
  using index = FmIndexBytes.from(text);
  const patterns = Uint8Array.of(0, 255, 0, 0, 1, 2);
  const offsets = Uint32Array.of(0, 0, 1, 3, 5, 6);
  const output = index.countMany(patterns, offsets);
  assertEquals(output.join(","), "8,4,2,1,0", "batch counts");
});

Deno.test("FmIndexBytes locates sampled suffix-array positions", () => {
  const encoder = new TextEncoder();
  using index = FmIndexBytes.from(encoder.encode("banana"));
  assertEquals(Array.from(index.locate(encoder.encode("ana"))).sort().join(","), "1,3", "ana");
  assertEquals(Array.from(index.locate(encoder.encode("na"))).sort().join(","), "2,4", "na");
  assertEquals(index.locate(encoder.encode("x")).length, 0, "missing");
  const patterns = encoder.encode("ananaX");
  const located = index.locateMany(patterns, Uint32Array.of(0, 3, 5, 6));
  assertEquals(located.offsets.join(","), "0,2,4,4", "result offsets");
  assertEquals(
    Array.from(located.positions.subarray(0, 2)).sort().join(","),
    "1,3",
    "first positions",
  );
  assertEquals(
    Array.from(located.positions.subarray(2, 4)).sort().join(","),
    "2,4",
    "second positions",
  );
});

Deno.test("FmIndexBytes matches scalar randomized pattern counts", () => {
  let state = 0x1020_3040;
  const text = Uint8Array.from({ length: 2_048 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state & 15;
  });
  using index = FmIndexBytes.from(text);
  for (let query = 0; query < 250; query++) {
    const length = query % 9;
    const pattern = new Uint8Array(length);
    for (let byte = 0; byte < length; byte++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      pattern[byte] = state & 15;
    }
    const expectedCount = scalarByteCount(text, pattern);
    assertEquals(index.count(pattern), expectedCount, `query=${query}`);
    if (query < 32) {
      assertEquals(
        Array.from(index.locate(pattern)).sort((left, right) => left - right).join(","),
        scalarBytePositions(text, pattern).join(","),
        `locate query=${query}`,
      );
    }
  }
});

Deno.test("FmIndexBytes using lifecycle returns allocator storage", () => {
  const before = FmIndexBytes.allocatorStats();
  {
    using index = FmIndexBytes.from(new Uint8Array(10_000));
    assertEquals(index.count(Uint8Array.of(0, 0)), 9_999, "resident count");
  }
  const after = FmIndexBytes.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

function scalarByteCount(text: Uint8Array, pattern: Uint8Array): number {
  if (pattern.length === 0) return text.length + 1;
  let count = 0;
  outer:
  for (let start = 0; start + pattern.length <= text.length; start++) {
    for (let index = 0; index < pattern.length; index++) {
      if (text[start + index] !== pattern[index]) continue outer;
    }
    count++;
  }
  return count;
}

function scalarBytePositions(text: Uint8Array, pattern: Uint8Array): number[] {
  if (pattern.length === 0) return Array.from({ length: text.length + 1 }, (_, index) => index);
  const positions: number[] = [];
  outer:
  for (let start = 0; start + pattern.length <= text.length; start++) {
    for (let index = 0; index < pattern.length; index++) {
      if (text[start + index] !== pattern[index]) continue outer;
    }
    positions.push(start);
  }
  return positions;
}

Deno.test("CompressedStringTable preserves front-coded arbitrary byte strings", () => {
  const encoder = new TextEncoder();
  const keys = [
    encoder.encode("src/components/button/render.ts"),
    encoder.encode("src/components/button/style.ts"),
    encoder.encode("src/components/input/render.ts"),
    Uint8Array.of(0, 1, 0, 2),
  ];
  using table = CompressedStringTable.from(keys);
  assertEquals(table.length, keys.length, "length");
  for (let id = 0; id < keys.length; id++) {
    assertEquals(table.get(id).join(","), keys[id]!.join(","), `get id=${id}`);
    assertEquals(table.equals(id, keys[id]!), true, `equals id=${id}`);
  }
  assertEquals(table.equals(0, encoder.encode("src/components/button/style.ts")), false, "miss");
});

Deno.test("CompressedStringTable batches equality without decoding", () => {
  const encoder = new TextEncoder();
  const keys = Array.from(
    { length: 64 },
    (_, index) =>
      encoder.encode(`packages/compiler/src/shared-prefix-${index.toString(16).padStart(4, "0")}`),
  );
  using table = CompressedStringTable.from(keys);
  const ids = Uint32Array.of(0, 17, 63, 10);
  const queryList = [keys[0]!, keys[17]!, encoder.encode("missing"), keys[11]!];
  const queryOffsets = new Uint32Array(queryList.length + 1);
  let total = 0;
  for (let index = 0; index < queryList.length; index++) {
    total += queryList[index]!.length;
    queryOffsets[index + 1] = total;
  }
  const queries = new Uint8Array(total);
  for (let index = 0; index < queryList.length; index++) {
    queries.set(queryList[index]!, queryOffsets[index]);
  }
  assertEquals(table.equalsMany(ids, queries, queryOffsets).join(","), "1,1,0,0", "matches");
  assertEquals(table.encodedBytes < table.uncompressedBytes, true, "front coding saves space");
});

Deno.test("CompressedStringTable using lifecycle returns allocator storage", () => {
  const before = CompressedStringTable.allocatorStats();
  {
    using table = CompressedStringTable.from(
      Array.from({ length: 1_000 }, (_, index) => new TextEncoder().encode(`common/${index}`)),
    );
    assertEquals(table.length, 1_000, "resident table");
  }
  const after = CompressedStringTable.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("WaveletMatrixUint32 supports range statistics", () => {
  using matrix = WaveletMatrixUint32.from([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  assertEquals(matrix.rangeFreq(0, 9, 2, 6), 5, "values in [2,6)");
  assertEquals(matrix.rangeFreq(2, 8, 0, 0x1_0000_0000), 6, "full Uint32 range");
  assertEquals(matrix.quantile(0, 9, 0), 1, "minimum");
  assertEquals(matrix.quantile(0, 9, 4), 4, "median");
  assertEquals(matrix.quantile(2, 8, 5), 9, "subrange maximum");
  assertEquals(matrix.predecessor(0, 9, 5), 4, "strict predecessor");
  assertEquals(matrix.predecessor(0, 9, 1), -1, "missing predecessor");
});

Deno.test("WaveletMatrixUint32 preserves the complete Uint32 domain", () => {
  using matrix = WaveletMatrixUint32.from([0xffff_ffff, 0, 0x8000_0000, 0xffff_ffff]);
  assertEquals(matrix.access(0), 0xffff_ffff, "Uint32 max access");
  assertEquals(matrix.quantile(0, 4, 2), 0xffff_ffff, "unsigned quantile");
  assertEquals(matrix.rank(0xffff_ffff, 4), 2, "Uint32 max rank");
  assertEquals(matrix.predecessor(0, 4, 0x1_0000_0000), 0xffff_ffff, "full-range max");
});

Deno.test("WaveletMatrixUint32 batches independent queries", () => {
  using matrix = WaveletMatrixUint32.from([7, 2, 9, 2, 4, 8]);
  const accessOutput = new Uint32Array(3);
  matrix.accessMany(new Uint32Array([5, 0, 3]), accessOutput);
  assertEquals(accessOutput.join(","), "8,7,2", "accessMany");

  const rankOutput = new Uint32Array(3);
  matrix.rankMany(new Uint32Array([2, 9, 7]), new Uint32Array([4, 6, 1]), rankOutput);
  assertEquals(rankOutput.join(","), "2,1,1", "rankMany");

  const quantileOutput = new Uint32Array(3);
  matrix.quantileMany(
    new Uint32Array([0, 1, 0]),
    new Uint32Array([6, 5, 6]),
    new Uint32Array([0, 2, 5]),
    quantileOutput,
  );
  assertEquals(quantileOutput.join(","), "2,4,9", "quantileMany");
});

Deno.test("WaveletMatrixUint32 matches scalar randomized range queries", () => {
  let state = 0x6d2b_79f5;
  for (const length of [0, 1, 31, 32, 127, 128, 129, 1025]) {
    const values = Uint32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    });
    using matrix = WaveletMatrixUint32.from(values);
    for (let query = 0; query < 40; query++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const left = length === 0 ? 0 : state % (length + 1);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const right = left + (length === left ? 0 : state % (length - left + 1));
      if (left === right) continue;
      const sorted = Array.from(values.slice(left, right)).sort((a, b) => a - b);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const kth = state % sorted.length;
      assertEquals(matrix.quantile(left, right, kth), sorted[kth], `quantile ${length}/${query}`);
      const bound = state;
      const expectedFreq = sorted.filter((value) => value < bound).length;
      assertEquals(
        matrix.rangeFreq(left, right, 0, bound),
        expectedFreq,
        `rangeFreq ${length}/${query}`,
      );
    }
  }
});

Deno.test("WaveletMatrixUint32 randomized rank and select preserve duplicates", () => {
  let state = 0x243f_6a88;
  const values = Uint32Array.from({ length: 1025 }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state & 31;
  });
  using matrix = WaveletMatrixUint32.from(values);
  for (let value = 0; value < 32; value++) {
    const positions: number[] = [];
    for (let index = 0; index < values.length; index++) {
      if (values[index] === value) positions.push(index);
    }
    for (const end of [0, 1, 31, 32, 127, 128, 512, 1025]) {
      assertEquals(
        matrix.rank(value, end),
        positions.filter((position) => position < end).length,
        `duplicate rank ${value}/${end}`,
      );
    }
    for (let occurrence = 0; occurrence < positions.length; occurrence++) {
      assertEquals(
        matrix.select(value, occurrence),
        positions[occurrence],
        `duplicate select ${value}/${occurrence}`,
      );
    }
    assertEquals(matrix.select(value, positions.length), -1, `missing select ${value}`);
  }
});

Deno.test("WaveletMatrixUint32 validates empty and invalid contracts", () => {
  using empty = WaveletMatrixUint32.from([]);
  assertEquals(empty.rank(0, 0), 0, "empty rank");
  assertEquals(empty.rangeFreq(0, 0, 0, 0x1_0000_0000), 0, "empty frequency");
  assertEquals(empty.predecessor(0, 0, 10), -1, "empty predecessor");

  let threw = false;
  try {
    empty.quantile(0, 0, 0);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "empty quantile rejects kth");

  const before = WaveletMatrixUint32.allocatorStats();
  threw = false;
  try {
    WaveletMatrixUint32.from([0, -1]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "invalid Uint32 input");
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "invalid construction allocations");
});

Deno.test("WaveletMatrixUint32 using lifecycle returns allocator storage", () => {
  const before = WaveletMatrixUint32.allocatorStats();
  {
    using matrix = WaveletMatrixUint32.from(
      Uint32Array.from({ length: 10_000 }, (_, index) => Math.imul(index, 2_654_435_761) >>> 0),
    );
    assertEquals(matrix.length, 10_000, "live wavelet matrix");
  }
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "wavelet allocations");
  assertEquals(after.liveBytes, before.liveBytes, "wavelet bytes");
});

Deno.test("WaveletMatrixUint32 allocator reaches a construction plateau", () => {
  const values = Uint32Array.from(
    { length: 1025 },
    (_, index) => Math.imul(index, 2_654_435_761) >>> 0,
  );
  for (let iteration = 0; iteration < 20; iteration++) {
    using matrix = WaveletMatrixUint32.from(values);
    matrix.rank(iteration, matrix.length);
  }
  const plateau = WaveletMatrixUint32.allocatorStats();
  for (let iteration = 0; iteration < 20; iteration++) {
    using matrix = WaveletMatrixUint32.from(values);
    matrix.quantile(0, matrix.length, iteration);
  }
  const after = WaveletMatrixUint32.allocatorStats();
  assertEquals(after.liveAllocations, plateau.liveAllocations, "plateau live allocations");
  assertEquals(after.liveBytes, plateau.liveBytes, "plateau live bytes");
  assertEquals(after.reservedBytes, plateau.reservedBytes, "plateau reserved bytes");
});

Deno.test("EliasFanoSequence preserves monotone values and duplicates", () => {
  using sequence = EliasFanoSequence.from([1, 1, 2, 4, 4, 4, 100]);
  assertEquals(sequence.length, 7, "Elias-Fano length");
  assertEquals(sequence.toUint32Array().join(","), "1,1,2,4,4,4,100", "Elias-Fano decode");
  assertEquals(sequence.at(0), 1, "first value");
  assertEquals(sequence.at(6), 100, "last value");
  assertEquals(sequence.rank(0), 0, "rank below minimum");
  assertEquals(sequence.rank(1), 0, "strict rank");
  assertEquals(sequence.rank(4), 3, "rank before duplicates");
  assertEquals(sequence.rank(101), 7, "rank above maximum");
  assertEquals(sequence.nextGEQ(3), 4, "nextGEQ");
  assertEquals(sequence.nextGEQ(101), -1, "missing nextGEQ");
  assertEquals(sequence.predecessor(4), 2, "strict predecessor");
  assertEquals(sequence.predecessor(1), -1, "missing predecessor");
});

Deno.test("EliasFanoSequence supports dense and complete Uint32 domains", () => {
  using dense = EliasFanoSequence.from([0, 0, 1, 1, 2, 3, 4]);
  assertEquals(dense.lowerBits, 0, "dense lower-bit width");
  assertEquals(dense.toUint32Array().join(","), "0,0,1,1,2,3,4", "dense values");

  using sparse = EliasFanoSequence.from([0, 0x8000_0000, 0xffff_ffff]);
  assertEquals(sparse.at(2), 0xffff_ffff, "Uint32 maximum");
  assertEquals(sparse.rank(0xffff_ffff), 2, "rank Uint32 maximum");
  assertEquals(sparse.rank(0x1_0000_0000), 3, "rank full Uint32 bound");
  assertEquals(sparse.nextGEQ(0x8000_0001), 0xffff_ffff, "sparse successor");

  using singleton = EliasFanoSequence.from([0xffff_ffff]);
  assertEquals(singleton.lowerBits, 32, "full-width lower part");
  assertEquals(singleton.at(0), 0xffff_ffff, "full-width lower value");
});

Deno.test("EliasFanoSequence builder freezes independent snapshots", () => {
  const builder = new EliasFanoSequenceBuilder();
  builder.append(1).append(1).append(10);
  using first = builder.freeze();
  builder.append(100);
  using second = builder.freeze();
  assertEquals(first.toUint32Array().join(","), "1,1,10", "first snapshot");
  assertEquals(second.toUint32Array().join(","), "1,1,10,100", "second snapshot");

  let threw = false;
  try {
    builder.append(99);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "descending append");
});

Deno.test("EliasFanoSequence batches independent point and rank queries", () => {
  using sequence = EliasFanoSequence.from([1, 3, 3, 9, 100, 1000]);
  const values = new Uint32Array(3);
  sequence.atMany(new Uint32Array([5, 0, 3]), values);
  assertEquals(values.join(","), "1000,1,9", "Elias-Fano atMany");

  const ranks = new Uint32Array(4);
  sequence.rankMany(new Uint32Array([0, 3, 4, 0xffff_ffff]), ranks);
  assertEquals(ranks.join(","), "0,1,3,6", "Elias-Fano rankMany");
});

Deno.test("EliasFanoSequence matches scalar randomized monotone sequences", () => {
  let state = 0x1319_8a2e;
  for (const length of [0, 1, 31, 32, 127, 128, 129, 4097]) {
    const values = new Uint32Array(length);
    let value = 0;
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      value += state & 7;
      values[index] = value;
    }
    using sequence = EliasFanoSequence.fromUint32Array(values);
    assertEquals(sequence.toUint32Array().join(","), values.join(","), `EF decode ${length}`);
    for (let query = 0; query < 100; query++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const target = length === 0 ? state : state % (value + 10);
      let expectedRank = 0;
      while (expectedRank < values.length && values[expectedRank]! < target) expectedRank++;
      assertEquals(sequence.rank(target), expectedRank, `EF rank ${length}/${query}`);
      assertEquals(
        sequence.nextGEQ(target),
        expectedRank === length ? -1 : values[expectedRank],
        `EF next ${length}/${query}`,
      );
    }
  }
});

Deno.test("EliasFanoSequence using lifecycle reaches an allocator plateau", () => {
  const values = Uint32Array.from({ length: 10_000 }, (_, index) => index * 17);
  for (let iteration = 0; iteration < 10; iteration++) {
    using sequence = EliasFanoSequence.fromUint32Array(values);
    sequence.rank(iteration);
  }
  const plateau = EliasFanoSequence.allocatorStats();
  for (let iteration = 0; iteration < 10; iteration++) {
    using sequence = EliasFanoSequence.fromUint32Array(values);
    sequence.at(iteration);
  }
  const after = EliasFanoSequence.allocatorStats();
  assertEquals(after.liveAllocations, plateau.liveAllocations, "EF live allocations");
  assertEquals(after.liveBytes, plateau.liveBytes, "EF live bytes");
  assertEquals(after.reservedBytes, plateau.reservedBytes, "EF reserved bytes");
});

Deno.test("findByte matches Uint8Array#indexOf across SIMD boundaries", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 4096]) {
    for (const hit of [-1, 0, 1, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x5a;
      assertEquals(findByte(input, 0x5a), input.indexOf(0x5a), `length=${length}, hit=${hit}`);
    }
  }
});

Deno.test("findByte preserves view-relative bounds", () => {
  const input = new Uint8Array(128).fill(0x61);
  input[80] = 0x5a;
  assertEquals(findByte(input, 0x5a, 32, 96), 80, "bounded hit");
  assertEquals(findByte(input, 0x5a, 0, 64), -1, "bounded miss");
});

Deno.test("decodeUint32 decodes complete big- and little-endian batches", () => {
  const bigEndian = new Uint8Array([
    0x01,
    0x23,
    0x45,
    0x67,
    0x89,
    0xab,
    0xcd,
    0xef,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  const littleEndian = new Uint8Array([
    0x67,
    0x45,
    0x23,
    0x01,
    0xef,
    0xcd,
    0xab,
    0x89,
    0xff,
    0xff,
    0xff,
    0xff,
  ]);
  assertEquals(
    [...decodeUint32BE(bigEndian)].join(","),
    "19088743,2309737967,4294967295",
    "big endian",
  );
  assertEquals(
    [...decodeUint32LE(littleEndian)].join(","),
    "19088743,2309737967,4294967295",
    "little endian",
  );
  assertEquals(decodeUint32BE(new Uint8Array()).length, 0, "empty batch");
});

Deno.test("decodeUint32 validates complete words and respects input views", () => {
  const storage = new Uint8Array([0xff, 0x01, 0x23, 0x45, 0x67, 0xff]);
  assertEquals(decodeUint32BE(storage.subarray(1, 5))[0], 0x0123_4567, "relative view");
  let threw = false;
  try {
    decodeUint32BE(new Uint8Array(5));
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "partial word");
});

Deno.test("reverseFindByte matches Uint8Array#lastIndexOf", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 4096]) {
    for (const hit of [-1, 0, 1, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x5a;
      assertEquals(
        reverseFindByte(input, 0x5a),
        input.lastIndexOf(0x5a),
        `length=${length}, hit=${hit}`,
      );
    }
  }
});

Deno.test("findNonAscii returns the first non-ASCII offset", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 127, 128, 129, 4096]) {
    for (const hit of [-1, 0, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x80;
      const expected = input.findIndex((byte) => byte >= 0x80);
      assertEquals(findNonAscii(input), expected, `length=${length}, hit=${hit}`);
    }
  }
});

Deno.test("bytesEqual matches equal-length byte semantics", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 127, 128, 129, 4096]) {
    const left = new Uint8Array(length).fill(0x61);
    const right = left.slice();
    assertEquals(bytesEqual(left, right), true, `equal length=${length}`);
    if (length > 0) {
      right[length - 1] = 0x62;
      assertEquals(bytesEqual(left, right), false, `different length=${length}`);
    }
  }
  assertEquals(bytesEqual(new Uint8Array(1), new Uint8Array(2)), false, "different lengths");
});

Deno.test("lexicalCompare matches byte-wise lexicographical ordering", () => {
  const cases = [
    [[], []],
    [[1], [1]],
    [[1], [1, 0]],
    [[1, 2], [1, 3]],
    [new Array(256).fill(1), [...new Array(255).fill(1), 2]],
  ] as const;
  for (const [leftValues, rightValues] of cases) {
    const left = new Uint8Array(leftValues);
    const right = new Uint8Array(rightValues);
    let expected = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
      if (left[index] !== right[index]) {
        expected = left[index]! - right[index]!;
        break;
      }
    }
    if (expected === 0) expected = left.length - right.length;
    assertEquals(Math.sign(lexicalCompare(left, right)), Math.sign(expected), "lexical compare");
  }
});

function scalarIndexOfSubarray(input: Uint8Array, pattern: Uint8Array): number {
  if (pattern.length === 0) return 0;
  outer:
  for (let index = 0; index + pattern.length <= input.length; index++) {
    for (let offset = 0; offset < pattern.length; offset++) {
      if (input[index + offset] !== pattern[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

Deno.test("indexOfSubarray matches scalar search", () => {
  for (const inputLength of [0, 1, 15, 16, 17, 127, 128, 129, 4096]) {
    for (const pattern of [[], [0x61], [0x61, 0x62], [0x61, 0x61, 0x62]]) {
      const input = new Uint8Array(inputLength).fill(0x61);
      if (inputLength > 0) input[inputLength - 1] = 0x62;
      const needle = new Uint8Array(pattern);
      assertEquals(
        indexOfSubarray(input, needle),
        scalarIndexOfSubarray(input, needle),
        `input=${inputLength}, pattern=${pattern}`,
      );
    }
  }
});

Deno.test("high-level kernels match randomized scalar references", () => {
  let state = 0x1234_5678;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let trial = 0; trial < 200; trial++) {
    const input = Uint8Array.from({ length: next() % 512 }, () => next() & 7);
    const pattern = Uint8Array.from({ length: next() % 40 }, () => next() & 7);
    assertEquals(
      indexOfSubarray(input, pattern),
      scalarIndexOfSubarray(input, pattern),
      `random subarray trial=${trial}`,
    );
    const other = Uint8Array.from({ length: next() % 512 }, () => next() & 7);
    let expected = 0;
    const length = Math.min(input.length, other.length);
    for (let index = 0; index < length; index++) {
      if (input[index] !== other[index]) {
        expected = input[index]! - other[index]!;
        break;
      }
    }
    if (expected === 0) expected = input.length - other.length;
    assertEquals(
      Math.sign(lexicalCompare(input, other)),
      Math.sign(expected),
      `random compare trial=${trial}`,
    );
  }
});

function scalarJsonTokenStarts(input: Uint8Array): Uint32Array {
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let previousIsAtom = false;
  for (let offset = 0; offset < input.length; offset++) {
    const byte = input[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) {
        starts.push(offset);
        inString = false;
      }
      previousIsAtom = false;
    } else if (byte === 0x22) {
      starts.push(offset);
      inString = true;
      previousIsAtom = false;
    } else if (
      byte === 0x7b || byte === 0x7d || byte === 0x5b || byte === 0x5d ||
      byte === 0x3a || byte === 0x2c
    ) {
      starts.push(offset);
      previousIsAtom = false;
    } else if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      previousIsAtom = false;
    } else {
      if (!previousIsAtom) starts.push(offset);
      previousIsAtom = true;
    }
  }
  return new Uint32Array(starts);
}

Deno.test("jsonTokenStarts matches MoonBit scalar lexer", () => {
  const encoder = new TextEncoder();
  for (
    const source of [
      "",
      "null",
      ' { "a": [1, true, null] } ',
      '["x\\"y","\\\\",-12.5e+2]',
      '{"日本語":"値","emoji":"👀"}',
      '["1234567890123456",false,{"x":1}]',
    ]
  ) {
    const input = encoder.encode(source);
    assertEquals(
      Array.from(jsonTokenStarts(input)).join(","),
      Array.from(scalarJsonTokenStarts(input)).join(","),
      source,
    );
  }
  let state = 0x9e37_79b9;
  for (let trial = 0; trial < 200; trial++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const input = Uint8Array.from({ length: state % 512 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state & 0xff;
    });
    assertEquals(
      Array.from(jsonTokenStarts(input)).join(","),
      Array.from(scalarJsonTokenStarts(input)).join(","),
      `random bytes trial=${trial}`,
    );
  }
});

Deno.test("AdaptiveSimdPageI32 selects a physical encoding per page", () => {
  using constant = AdaptiveSimdPageI32.from([7, 7, 7]);
  using narrow = AdaptiveSimdPageI32.from([-100, -99, -50, -75]);
  using wide = AdaptiveSimdPageI32.from([-0x8000_0000, 0, 0x7fff_ffff]);
  assertEquals(constant.encoding, AdaptivePageEncoding.Constant, "constant encoding");
  assertEquals(constant.encodedBytes, 0, "constant payload");
  assertEquals(narrow.encoding, AdaptivePageEncoding.FrameOfReference, "FOR encoding");
  assertEquals(narrow.bitWidth, 6, "FOR width");
  assertEquals(wide.encoding, AdaptivePageEncoding.Raw, "raw encoding");
});

Deno.test("AdaptiveSimdPageI32 decodes, indexes, and reduces every encoding", () => {
  const cases = [
    [11, 11, 11, 11, 11],
    [-1000, -999, -750, -500, -989],
    [-0x8000_0000, 17, 0x7fff_ffff, -19, 1_000_000],
  ];
  for (const values of cases) {
    using page = AdaptiveSimdPageI32.from(values);
    const decoded = new Int32Array(values.length);
    assertEquals(page.decodeInto(decoded), values.length, "decoded count");
    assertEquals(decoded.join(","), values.join(","), `decode ${page.encoding}`);
    assertEquals(page.sum(), values.reduce((sum, value) => sum + value, 0), "sum");
    for (let index = 0; index < values.length; index++) {
      assertEquals(page.get(index), values[index], `get ${index}`);
    }
  }
});

Deno.test("AdaptiveSimdPageI32 scans into composable masks and gathers", () => {
  const values = [-3, 1, 4, 1, 5, 9, 2, 6];
  using page = AdaptiveSimdPageI32.from(values);
  using equal = new SimdPageMask(values.length);
  using less = new SimdPageMask(values.length);
  using range = new SimdPageMask(values.length);
  assertEquals(page.scanEq(1, equal).toIndices().join(","), "1,3", "equal");
  assertEquals(page.scanLt(4, less).toIndices().join(","), "0,1,3,6", "less");
  assertEquals(
    page.scanBetween(1, 6, range).toIndices().join(","),
    "1,2,3,4,6",
    "between",
  );
  equal.orAssign(less).differenceAssign(range);
  assertEquals(equal.toIndices().join(","), "0", "mask composition");

  page.scanBetween(1, 6, range);
  const gathered = new Int32Array(range.countOnes());
  assertEquals(page.gatherInto(range, gathered), 5, "gathered count");
  assertEquals(gathered.join(","), "1,4,1,5,2", "gathered values");
});

Deno.test("AdaptiveSimdPageI32 matches scalar predicates across SIMD tails", () => {
  let state = 0x6d2b_79f5;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    return state;
  };
  for (const length of [0, 1, 3, 4, 5, 31, 32, 33, 127, 128, 129, 255, 256]) {
    for (const narrow of [true, false]) {
      const values = Int32Array.from(
        { length },
        narrow ? () => -10_000 + (next() & 1023) : () => next(),
      );
      using page = AdaptiveSimdPageI32.from(values);
      using mask = new SimdPageMask(length);
      const decoded = new Int32Array(length);
      page.decodeInto(decoded);
      assertEquals(decoded.join(","), values.join(","), `decode n=${length}, narrow=${narrow}`);
      const target = values[length >>> 1] ?? 0;
      const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === target);
      assertEquals(
        page.scanEq(target, mask).toIndices().join(","),
        expectedEqual.join(","),
        `equal n=${length}, narrow=${narrow}`,
      );
      const expectedLess = Array.from(values.keys()).filter((index) => values[index]! < target);
      assertEquals(
        page.scanLt(target, mask).toIndices().join(","),
        expectedLess.join(","),
        `less n=${length}, narrow=${narrow}`,
      );
      for (
        const [minimum, maximum] of [
          [-10_000, -9_500],
          [-1, 1],
          [-0x8000_0000, 0x8000_0000],
        ]
      ) {
        const expected = Array.from(values.keys()).filter((index) =>
          values[index]! >= minimum && values[index]! < maximum
        );
        assertEquals(
          page.scanBetween(minimum, maximum, mask).toIndices().join(","),
          expected.join(","),
          `between n=${length}, narrow=${narrow}`,
        );
      }
    }
  }
});

Deno.test("AdaptiveSimdPageI32 validates page and mask contracts", () => {
  let threw = false;
  try {
    AdaptiveSimdPageI32.from(new Int32Array(257));
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "page length");
  threw = false;
  try {
    AdaptiveSimdPageI32.from([1.5]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "i32 values");

  using page = AdaptiveSimdPageI32.from([1, 2, 3]);
  using wrongMask = new SimdPageMask(2);
  threw = false;
  try {
    page.scanEq(1, wrongMask);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "mask length");
});

Deno.test("AdaptiveSimdPageI32 snapshots Int32Array input", () => {
  const values = new Int32Array([-0x8000_0000, 17, 0x7fff_ffff]);
  using page = AdaptiveSimdPageI32.from(values);
  values.fill(0);
  assertEquals(
    page.toInt32Array().join(","),
    "-2147483648,17,2147483647",
    "snapshot",
  );
});

Deno.test("AdaptiveSimdPageI32 using lifecycle returns allocator storage", () => {
  const before = AdaptiveSimdPageI32.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    using page = AdaptiveSimdPageI32.from(Int32Array.from({ length: 256 }, (_, i) => i));
    using mask = new SimdPageMask(page.length);
    assertEquals(page.scanLt(128, mask).countOnes(), 128, "live page");
  }
  const after = AdaptiveSimdPageI32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
  if (after.reservedBytes > before.reservedBytes + 512) {
    throw new Error(
      `adaptive page storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
});

Deno.test("AdaptiveSimdColumnI32 partitions values into independently encoded pages", () => {
  const values = Int32Array.from({ length: 600 }, (_, index) => {
    if (index < 256) return 7;
    if (index < 512) return -1000 + (index & 63);
    return index % 2 === 0 ? -0x8000_0000 : 0x7fff_ffff;
  });
  using column = AdaptiveSimdColumnI32.from(values);
  assertEquals(column.length, 600, "length");
  assertEquals(column.pageSize, 256, "page size");
  assertEquals(column.pageCount, 3, "page count");
  assertEquals(column.get(255), 7, "get before boundary");
  assertEquals(column.get(256), -1000, "get after boundary");
  assertEquals(column.min, -0x8000_0000, "minimum");
  assertEquals(column.max, 0x7fff_ffff, "maximum");
  assertEquals(column.toInt32Array().join(","), values.join(","), "decode");
  assertEquals(
    column.sum(),
    values.reduce((sum, value) => sum + value, 0),
    "sum",
  );
  const encodings = column.encodingCounts();
  assertEquals(encodings.constant, 1, "constant pages");
  assertEquals(encodings.frameOfReference, 1, "FOR pages");
  assertEquals(encodings.raw, 1, "raw pages");
});

Deno.test("AdaptiveSimdColumnI32 scans, composes masks, and gathers across pages", () => {
  const values = Int32Array.from({ length: 777 }, (_, index) => (index * 17 % 101) - 50);
  using column = AdaptiveSimdColumnI32.from(values, 129);
  using equal = new SimdColumnMask(values.length, 129);
  using less = new SimdColumnMask(values.length, 129);
  using range = new SimdColumnMask(values.length, 129);

  const expectedEqual = Array.from(values.keys()).filter((index) => values[index] === 7);
  assertEquals(column.scanEq(7, equal).toIndices().join(","), expectedEqual.join(","), "equal");
  const expectedLess = Array.from(values.keys()).filter((index) => values[index]! < -13);
  assertEquals(column.scanLt(-13, less).toIndices().join(","), expectedLess.join(","), "less");
  const expectedRange = Array.from(values.keys()).filter((index) =>
    values[index]! >= -5 && values[index]! < 19
  );
  assertEquals(
    column.scanBetween(-5, 19, range).toIndices().join(","),
    expectedRange.join(","),
    "between",
  );

  equal.orAssign(less).differenceAssign(range);
  const expectedComposed = Array.from(values.keys()).filter((index) =>
    (values[index] === 7 || values[index]! < -13) &&
    !(values[index]! >= -5 && values[index]! < 19)
  );
  assertEquals(equal.toIndices().join(","), expectedComposed.join(","), "composition");

  column.scanBetween(-5, 19, range);
  const gathered = new Int32Array(range.countOnes());
  assertEquals(column.gatherInto(range, gathered), expectedRange.length, "gather count");
  assertEquals(
    gathered.join(","),
    expectedRange.map((index) => values[index]).join(","),
    "gather values",
  );
});

Deno.test("AdaptiveSimdColumnI32 matches scalar predicates across page tails", () => {
  let state = 0x85eb_ca6b;
  for (const length of [0, 1, 128, 129, 130, 255, 256, 257, 513, 1025]) {
    const values = Int32Array.from({ length }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      return state;
    });
    using column = AdaptiveSimdColumnI32.from(values, 129);
    using mask = new SimdColumnMask(length, 129);
    const target = values[length >>> 1] ?? 0;
    const expected = Array.from(values.keys()).filter((index) => values[index]! < target);
    assertEquals(
      column.scanLt(target, mask).toIndices().join(","),
      expected.join(","),
      `length=${length}`,
    );
  }
});

Deno.test("AdaptiveSimdColumnI32 using lifecycle releases every page and mask", () => {
  const before = AdaptiveSimdPageI32.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using column = AdaptiveSimdColumnI32.from(
      Int32Array.from({ length: 1025 }, (_, index) => index - 512),
      129,
    );
    using mask = new SimdColumnMask(column.length, column.pageSize);
    assertEquals(column.scanLt(0, mask).countOnes(), 512, "live column");
  }
  const after = AdaptiveSimdPageI32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("SparseBitMatrix canonicalizes CSR rows and transposes", () => {
  using matrix = SparseBitMatrix.fromEdges(4, 5, [
    [0, 3],
    [0, 1],
    [0, 3],
    [2, 4],
    [3, 0],
  ]);
  assertEquals(matrix.edgeCount, 4, "deduplicated edges");
  assertEquals(matrix.row(0).toArray().join(","), "1,3", "sorted row");
  assertEquals(matrix.row(1).countOnes(), 0, "empty row");
  assertEquals(matrix.has(2, 4), true, "present edge");
  assertEquals(matrix.has(2, 3), false, "missing edge");
  using transposed = matrix.transpose();
  assertEquals(transposed.rows, 5, "transpose rows");
  assertEquals(transposed.columns, 4, "transpose columns");
  assertEquals(transposed.row(3).toArray().join(","), "0", "transpose edge");
});

Deno.test("SparseBitMatrix using lifecycle returns CSR storage", () => {
  const before = SparseBitMatrix.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using graph = SparseBitMatrix.fromEdges(
      1024,
      1024,
      Array.from(
        { length: 4096 },
        (_, index) => [index & 1023, (Math.imul(index, 17) + 1) & 1023] as const,
      ),
    );
    assertEquals(graph.countRowOnes(0) > 0, true, "live graph");
  }
  const after = SparseBitMatrix.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("PartitionedEliasFanoSequence adapts contiguous and local EF blocks", () => {
  const values = Uint32Array.from([
    100,
    101,
    102,
    103,
    1_000_000,
    1_000_003,
    1_000_010,
    1_000_100,
    4_000_000_000,
    4_000_000_000,
    4_000_000_001,
  ]);
  using sequence = PartitionedEliasFanoSequence.fromUint32Array(values, 4);
  assertEquals(sequence.length, values.length, "length");
  assertEquals(sequence.blockSize, 4, "block size");
  assertEquals(sequence.blockCount, 3, "block count");
  assertEquals(sequence.encodingCounts().contiguous, 1, "contiguous blocks");
  assertEquals(sequence.encodingCounts().eliasFano, 2, "EF blocks");
  assertEquals(sequence.toUint32Array().join(","), values.join(","), "decode");
  for (let index = 0; index < values.length; index++) {
    assertEquals(sequence.at(index), values[index], `at ${index}`);
  }
});

Deno.test("PartitionedEliasFanoSequence preserves ordered queries across duplicate boundaries", () => {
  const builder = new PartitionedEliasFanoSequenceBuilder(3);
  for (const value of [1, 2, 2, 2, 2, 7, 100, 101, 102]) builder.append(value);
  using sequence = builder.freeze();
  for (const query of [0, 1, 2, 3, 7, 8, 102, 103, 2 ** 32]) {
    const values = [1, 2, 2, 2, 2, 7, 100, 101, 102];
    const expected = values.findIndex((value) => value >= query);
    const rank = expected === -1 ? values.length : expected;
    assertEquals(sequence.rank(query), rank, `rank ${query}`);
    assertEquals(
      sequence.nextGEQ(query),
      rank === values.length ? -1 : values[rank],
      `next ${query}`,
    );
    assertEquals(sequence.predecessor(query), rank === 0 ? -1 : values[rank - 1], `prev ${query}`);
  }
});

Deno.test("PartitionedEliasFanoSequence using lifecycle releases child encodings", () => {
  const before = EliasFanoSequence.allocatorStats();
  {
    using sequence = PartitionedEliasFanoSequence.fromUint32Array(
      Uint32Array.from({ length: 1000 }, (_, index) => index * index),
      128,
    );
    assertEquals(sequence.at(999), 998001, "live sequence");
  }
  const after = EliasFanoSequence.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("PdxFloat32Index computes exact squared L2 distances in four-row blocks", () => {
  const count = 7;
  const dimensions = 5;
  const values = Float32Array.from(
    { length: count * dimensions },
    (_, index) => (index % 13) * 0.25 - 1.5,
  );
  const query = Float32Array.from({ length: dimensions }, (_, index) => index * 0.1 - 0.2);
  using index = PdxFloat32Index.from(values, count, dimensions);
  const actual = index.distanceMany(query, new Float32Array(count));
  for (let row = 0; row < count; row++) {
    let expected = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const delta = values[row * dimensions + dimension]! - query[dimension]!;
      expected += delta * delta;
    }
    assertClose(actual[row]!, expected, 1e-5, `row=${row}`);
  }
  const selected = index.distanceSelected(
    query,
    new Uint32Array([6, 0, 3]),
    new Float32Array(3),
  );
  assertClose(selected[0]!, actual[6]!, 1e-5, "selected 6");
  assertClose(selected[1]!, actual[0]!, 1e-5, "selected 0");
  assertClose(selected[2]!, actual[3]!, 1e-5, "selected 3");
});

Deno.test("BinaryVectorIndexWithRerank refines Hamming candidates with exact Float32 L2", () => {
  const values = new Float32Array([
    0.1,
    0.1,
    0.1,
    10,
    10,
    10,
    -0.1,
    -0.1,
    -0.1,
    0.2,
    0.2,
    0.2,
    -10,
    -10,
    -10,
  ]);
  using index = BinaryVectorIndexWithRerank.fromFloat32(values, 5, 3);
  const ids = new Uint32Array(3);
  const distances = new Float32Array(3);
  assertEquals(index.topK(new Float32Array([0, 0, 0]), 3, 5, ids, distances), 3, "count");
  assertEquals(ids.join(","), "0,2,3", "exact order");
  assertClose(distances[0]!, 0.03, 1e-5, "first distance");
  assertClose(distances[1]!, 0.03, 1e-5, "second distance");
  assertClose(distances[2]!, 0.12, 1e-5, "third distance");
});

Deno.test("PDX and rerank using lifecycle release all resident storage", () => {
  const before = BinaryVectorIndex.allocatorStats();
  {
    const values = Float32Array.from({ length: 1024 * 17 }, (_, index) => index % 19);
    using index = BinaryVectorIndexWithRerank.fromFloat32(values, 1024, 17);
    const ids = new Uint32Array(10);
    const distances = new Float32Array(10);
    index.topK(new Float32Array(17), 10, 100, ids, distances);
  }
  const after = BinaryVectorIndex.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("FlatHashMapU64U32 distinguishes the complete unsigned 64-bit key space", () => {
  using map = new FlatHashMapU64U32();
  const entries = [
    [0n, 1],
    [1n, 2],
    [0xffff_ffffn, 3],
    [0x1_0000_0000n, 4],
    [0xffff_ffff_ffff_ffffn, 5],
  ] as const;
  for (const [key, value] of entries) map.set(key, value);
  assertEquals(map.size, entries.length, "size");
  for (const [key, value] of entries) assertEquals(map.get(key), value, `get ${key}`);
  map.set(0x1_0000_0000n, 99);
  assertEquals(map.size, entries.length, "update size");
  assertEquals(map.get(0x1_0000_0000n), 99, "updated value");
  assertEquals(map.has(9n), false, "missing key");
  assertEquals(map.delete(1n), true, "delete present");
  assertEquals(map.delete(1n), false, "delete absent");
});

Deno.test("FlatHashMapU64U32 batches BigUint64Array inserts and lookups", () => {
  const keys = BigUint64Array.from(
    { length: 10_000 },
    (_, index) => BigInt(index) * 0x9e37_79b9_7f4a_7c15n & 0xffff_ffff_ffff_ffffn,
  );
  const values = Uint32Array.from(keys, (_, index) => Math.imul(index, 17) >>> 0);
  using map = new FlatHashMapU64U32(keys.length);
  map.insertMany(keys, values);
  assertEquals(map.size, keys.length, "bulk size");
  const queries = new BigUint64Array([keys[1]!, 123n, keys[9999]!, 0xffffn]);
  const output = new Uint32Array(queries.length);
  const present = new Uint8Array(queries.length);
  assertEquals(map.lookupMany(queries, output, present), 2, "found count");
  assertEquals(present.join(","), "1,0,1,0", "presence");
  assertEquals(output[0], values[1], "first value");
  assertEquals(output[2], values[9999], "last value");
});

Deno.test("FlatHashMapU64U32 using lifecycle releases resized storage", () => {
  const before = FlatHashMapU64U32.allocatorStats();
  {
    using map = new FlatHashMapU64U32();
    for (let index = 0; index < 20_000; index++) {
      map.set(BigInt(index) << 33n | BigInt(index), index);
    }
    assertEquals(map.size, 20_000, "live map");
  }
  const after = FlatHashMapU64U32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("StaticMphfU32 maps every known key to a unique dense ID", () => {
  const keys = new Uint32Array([0, 1, 7, 42, 65_536, 0x8000_0000, 0xffff_ffff]);
  using index = StaticMphfU32.fromUint32Array(keys);
  assertEquals(index.length, keys.length, "length");
  const ids = new Set<number>();
  for (const key of keys) {
    const id = index.lookup(key);
    if (id < 0 || id >= keys.length) throw new Error(`invalid ID ${id} for ${key}`);
    ids.add(id);
  }
  assertEquals(ids.size, keys.length, "unique IDs");
  assertEquals(index.has(123_456_789), false, "unknown key");
  assertEquals(index.fingerprintBits, 16, "fingerprint bits");
});

Deno.test("StaticMphfBytes maps arbitrary known keys to exact dense IDs", () => {
  const prefix = new Uint8Array(40).fill(0x61);
  const tail = prefix.slice();
  tail[39] = 0x62;
  using mphf = StaticMphfBytes.from([
    new Uint8Array(),
    byteKey(0, 1, 0, 2),
    prefix,
    tail,
  ]);
  const ids = [
    mphf.lookup(new Uint8Array()),
    mphf.lookup(byteKey(0, 1, 0, 2)),
    mphf.lookup(prefix),
    mphf.lookup(tail),
  ];
  assertEquals(new Set(ids).size, 4, "unique dense IDs");
  assertEquals(ids.every((id) => id >= 0 && id < 4), true, "dense ID range");
  assertEquals(mphf.lookup(byteKey(0, 1, 0, 3)), -1, "exact miss");
});

Deno.test("StaticMphfBytes batches concatenated exact-key lookup", () => {
  const keys = byteKey(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const offsets = Uint32Array.of(0, 0, 1, 4, 9);
  using mphf = StaticMphfBytes.fromBytes(keys, offsets);
  const queries = byteKey(2, 3, 4, 99, 1, 5, 6, 7, 8, 9);
  const queryOffsets = Uint32Array.of(0, 3, 4, 5, 10);
  const output = new Int32Array(4);
  assertEquals(mphf.lookupMany(queries, queryOffsets, output), 3, "batch hits");
  assertEquals(output[1], -1, "batch miss");
  assertEquals(new Set([output[0], output[2], output[3]]).size, 3, "batch IDs");
});

Deno.test("FrozenByteMapU32 stores values in MPHF slot order", () => {
  const keys = byteKey(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const offsets = Uint32Array.of(0, 0, 1, 4, 9);
  using map = FrozenByteMapU32.fromBytes(keys, offsets, Uint32Array.of(10, 20, 30, 40));
  assertEquals(map.get(new Uint8Array()), 10, "empty key value");
  assertEquals(map.get(byteKey(2, 3, 4)), 30, "middle key value");
  assertEquals(map.get(byteKey(99)), undefined, "missing value");
  const queries = byteKey(5, 6, 7, 8, 9, 99, 1);
  const queryOffsets = Uint32Array.of(0, 5, 6, 7);
  const values = new Uint32Array(3);
  const present = new Uint8Array(3);
  assertEquals(map.lookupMany(queries, queryOffsets, values, present), 2, "map batch hits");
  assertEquals(values.join(","), "40,0,20", "map batch values");
  assertEquals(present.join(","), "1,0,1", "map batch presence");
});

Deno.test("StaticMphfBytes validates uniqueness and releases using-owned storage", () => {
  let duplicateThrew = false;
  try {
    new StaticMphfBytesBuilder().add(byteKey(1, 2)).add(byteKey(1, 2));
  } catch (error) {
    duplicateThrew = error instanceof RangeError;
  }
  assertEquals(duplicateThrew, true, "duplicate keys rejected");
  const before = StaticMphfBytes.allocatorStats();
  {
    const builder = new StaticMphfBytesBuilder();
    for (let index = 0; index < 2_000; index++) builder.add(fixed16(index));
    using mphf = builder.freeze();
    assertEquals(mphf.length, 2_000, "built length");
  }
  const after = StaticMphfBytes.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("StaticMphfBytes preserves exact membership for randomized variable keys", () => {
  const keys: Uint8Array[] = [];
  let state = 0x6d2b_79f5;
  for (let input = 0; input < 5_000; input++) {
    const key = new Uint8Array(5 + (input % 59));
    new DataView(key.buffer).setUint32(0, input, true);
    for (let index = 4; index < key.length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      key[index] = state >>> 24;
    }
    keys.push(key);
  }
  using mphf = StaticMphfBytes.from(keys);
  const slots = new Set<number>();
  for (let input = 0; input < keys.length; input++) {
    const slot = mphf.lookup(keys[input]!);
    assertEquals(slot >= 0, true, `known input=${input}`);
    slots.add(slot);
    const miss = keys[input]!.slice();
    miss[0] ^= 0x80;
    assertEquals(mphf.lookup(miss), -1, `exact miss input=${input}`);
  }
  assertEquals(slots.size, keys.length, "minimal perfect slots");
});

Deno.test("FrozenByteMapU32 using lifecycle returns all owned allocations", () => {
  const before = FrozenByteMapU32.allocatorStats();
  {
    using map = FrozenByteMapU32.from(
      Array.from({ length: 2_000 }, (_, index) => [fixed16(index), index * 7] as const),
    );
    assertEquals(map.get(fixed16(1_999)), 13_993, "last value");
  }
  const after = FrozenByteMapU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("StaticMphfU32Builder freezes independent snapshots", () => {
  const builder = new StaticMphfU32Builder();
  builder.add(10).add(20).add(30);
  using first = builder.freeze();
  builder.add(40);
  using second = builder.freeze();
  assertEquals(first.length, 3, "first length");
  assertEquals(first.has(40), false, "first snapshot");
  assertEquals(second.length, 4, "second length");
  assertEquals(second.has(40), true, "second snapshot");
});

Deno.test("StaticMphfU32 batches membership and dense ID lookup", () => {
  const keys = Uint32Array.from({ length: 4096 }, (_, index) => Math.imul(index + 1, 0x9e37_79b1));
  using index = StaticMphfU32.fromUint32Array(keys);
  const queries = new Uint32Array([keys[0]!, 123, keys[777]!, 456, keys[4095]!]);
  const ids = new Int32Array(queries.length);
  assertEquals(index.lookupMany(queries, ids), 3, "found count");
  assertEquals(ids[1], -1, "first miss");
  assertEquals(ids[3], -1, "second miss");
  assertEquals(index.lookup(keys[0]!), ids[0], "first ID");
  assertEquals(index.lookup(keys[777]!), ids[2], "middle ID");
  assertEquals(index.lookup(keys[4095]!), ids[4], "last ID");
});

Deno.test("StaticMphfU32 handles empty indexes and every four-query tail", () => {
  using empty = StaticMphfU32.from([]);
  const emptyQueries = new Uint32Array([1, 2, 3]);
  const emptyOutput = new Int32Array(emptyQueries.length);
  assertEquals(empty.lookupMany(emptyQueries, emptyOutput), 0, "empty found count");
  assertEquals(emptyOutput.join(","), "-1,-1,-1", "empty output");

  const keys = Uint32Array.from({ length: 128 }, (_, index) => Math.imul(index + 1, 0x85eb_ca6b));
  using index = StaticMphfU32.fromUint32Array(keys);
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 15, 16, 17]) {
    const queries = Uint32Array.from(
      { length },
      (_, query) => (query & 1) === 0 ? keys[query & 127]! : query,
    );
    const expected = Int32Array.from(queries, (key) => index.lookup(key));
    const actual = new Int32Array(length);
    const expectedFound = expected.reduce((count, id) => count + Number(id >= 0), 0);
    assertEquals(index.lookupMany(queries, actual), expectedFound, `found n=${length}`);
    assertEquals(actual.join(","), expected.join(","), `IDs n=${length}`);
  }
});

Deno.test("StaticMphfU32 rejects duplicate and invalid construction keys", () => {
  for (const values of [[1, 2, 1], [-1], [0x1_0000_0000]]) {
    let threw = false;
    try {
      StaticMphfU32.from(values);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assertEquals(threw, true, `invalid ${values}`);
  }
});

Deno.test("StaticMphfU32 matches randomized known keys and rejects sampled misses", () => {
  const keys = Uint32Array.from(
    { length: 16_384 },
    (_, index) => Math.imul(index + 1, 0x9e37_79b1) >>> 0,
  );
  using index = StaticMphfU32.fromUint32Array(keys);
  const ids = new Uint8Array(keys.length);
  for (const key of keys) {
    const id = index.lookup(key);
    if (id < 0 || ids[id] !== 0) throw new Error(`missing or duplicate ID for ${key}`);
    ids[id] = 1;
  }
  let falsePositives = 0;
  for (let value = 0; value < 10_000; value++) {
    if (index.has(value)) falsePositives++;
  }
  if (falsePositives > 2) {
    throw new Error(`unexpected fingerprint false positives: ${falsePositives}`);
  }
});

Deno.test("StaticMphfU32 using lifecycle reaches an allocator plateau", () => {
  const values = Uint32Array.from(
    { length: 1024 },
    (_, index) => Math.imul(index + 1, 0x85eb_ca6b),
  );
  const before = StaticMphfU32.allocatorStats();
  for (let iteration = 0; iteration < 1000; iteration++) {
    using index = StaticMphfU32.fromUint32Array(values);
    assertEquals(index.has(values[iteration & 1023]!), true, "live index");
  }
  const after = StaticMphfU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
  if (after.reservedBytes > before.reservedBytes + 8192) {
    throw new Error(
      `MPHF storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
});

Deno.test("BinaryVectorIndex computes exact Hamming distances and top-k", () => {
  using index = BinaryVectorIndex.fromSignatures([
    new Uint8Array([0x00, 0x00]),
    new Uint8Array([0xff, 0x00]),
    new Uint8Array([0xff, 0xff]),
    new Uint8Array([0x0f, 0x0f]),
  ]);
  const distances = new Uint32Array(index.length);
  index.distanceMany(new Uint8Array([0x00, 0x00]), distances);
  assertEquals(distances.join(","), "0,8,16,8", "distances");
  const ids = new Uint32Array(3);
  const topDistances = new Uint32Array(3);
  assertEquals(index.topK(new Uint8Array([0, 0]), 3, ids, topDistances), 3, "top count");
  assertEquals(topDistances.join(","), "0,8,8", "top distances");
  assertEquals(ids[0], 0, "nearest ID");
});

Deno.test("BinaryVectorIndex quantizes Float32 signs", () => {
  using index = BinaryVectorIndex.fromFloat32(
    new Float32Array([1, -1, 0, 2, -3, 4, 5, -6, -1, -1, 1, 1, 1, 1, -1, -1]),
    2,
    8,
  );
  assertEquals(index.dimensions, 8, "dimensions");
  const distances = new Uint32Array(2);
  index.distanceMany(new Uint8Array([0b0110_1001]), distances);
  assertEquals(distances.join(","), "0,4", "quantized distances");
});

Deno.test("BinaryVectorIndex preserves non-byte-aligned Float32 dimensions", () => {
  using index = BinaryVectorIndex.fromFloat32(
    new Float32Array([
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
    ]),
    2,
    10,
  );
  assertEquals(index.dimensions, 10, "logical dimensions");
  const distances = new Uint32Array(2);
  // Bits 10..15 are padding and must not contribute to the logical distance.
  index.distanceMany(new Uint8Array([0xff, 0xff]), distances);
  assertEquals(distances.join(","), "0,10", "padding bits ignored");
});

Deno.test("BinaryVectorIndex matches scalar distances across SIMD tails", () => {
  for (const bytes of [1, 15, 16, 17, 31, 32, 33]) {
    const signatures = Array.from(
      { length: 129 },
      (_, row) =>
        Uint8Array.from({ length: bytes }, (_, column) => Math.imul(row + 1, column + 17) & 0xff),
    );
    const query = Uint8Array.from({ length: bytes }, (_, index) => Math.imul(index, 31) & 0xff);
    using index = BinaryVectorIndex.fromSignatures(signatures);
    const actual = new Uint32Array(signatures.length);
    index.distanceMany(query, actual);
    for (let row = 0; row < signatures.length; row++) {
      let expected = 0;
      for (let byte = 0; byte < bytes; byte++) {
        expected += ((signatures[row]![byte]! ^ query[byte]!) >>> 0).toString(2).split("1").length -
          1;
      }
      assertEquals(actual[row], expected, `bytes=${bytes}, row=${row}`);
    }
  }
});

Deno.test("BinaryVectorIndex using lifecycle returns storage", () => {
  const signatures = Array.from({ length: 256 }, () => new Uint8Array(32));
  const before = BinaryVectorIndex.allocatorStats();
  for (let iteration = 0; iteration < 1000; iteration++) {
    using index = BinaryVectorIndex.fromSignatures(signatures);
    const output = new Uint32Array(index.length);
    index.distanceMany(signatures[0]!, output);
  }
  const after = BinaryVectorIndex.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
