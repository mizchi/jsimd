import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  lexicalCompare,
  reverseFindByte,
} from "./src/bytes/mod.ts";
import { decodeUint32BE, decodeUint32LE } from "./src/endian/mod.ts";
import { FixedBitSet } from "./src/bitset/mod.ts";
import { SimdFloat32Vector } from "./src/f32-vector/mod.ts";
import { SimdInt32Array } from "./src/i32-array/mod.ts";
import { SimdMatrix2D } from "./src/matrix2d/mod.ts";
import { SimdMatrix3D } from "./src/matrix3d/mod.ts";
import {
  RankSelectBitVector,
  RankSelectBitVectorBuilder,
} from "./src/rank-select-bitvector/mod.ts";
import { jsonTokenStarts } from "./src/json/mod.ts";

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

Deno.test("RankSelectBitVector defines rank and select boundary semantics", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
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

Deno.test("RankSelectBitVector finds neighboring bits inclusively", () => {
  using bits = RankSelectBitVector.from(20, [0, 4, 9, 19]);
  assertEquals(bits.next1(0), 0, "next exact");
  assertEquals(bits.next1(1), 4, "next after gap");
  assertEquals(bits.next1(19), 19, "next last");
  assertEquals(bits.next1(20), -1, "next at end");
  assertEquals(bits.prev1(19), 19, "previous exact");
  assertEquals(bits.prev1(18), 9, "previous before gap");
  assertEquals(bits.prev1(0), 0, "previous first");
  assertEquals(bits.prev1(-1), -1, "previous before start");
});

Deno.test("RankSelectBitVector crosses 128-bit and 512-bit blocks", () => {
  const positions = [0, 31, 32, 127, 128, 510, 511, 512, 513, 1023, 1024, 1030];
  using bits = RankSelectBitVector.from(1031, positions);
  for (let index = 0; index < positions.length; index++) {
    assertEquals(bits.rank1(positions[index]!), index, `rank before ${positions[index]}`);
    assertEquals(bits.select1(index), positions[index], `select ${index}`);
  }
  assertEquals(bits.rank1(1031), positions.length, "rank tail");
});

Deno.test("RankSelectBitVectorBuilder freezes an immutable snapshot", () => {
  const builder = new RankSelectBitVectorBuilder(600);
  builder.insert(1).insert(511).insert(512).insert(599).remove(1);
  using frozen = builder.freeze();
  builder.insert(1).remove(512);
  assertEquals(frozen.get(1), false, "snapshot excludes removed bit");
  assertEquals(frozen.get(512), true, "snapshot retains later mutation");
  assertEquals(frozen.toArray().join(","), "511,512,599", "frozen values");
});

Deno.test("RankSelectBitVector executes rank and select queries in bulk", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  const before = RankSelectBitVector.allocatorStats();
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
  const after = RankSelectBitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bulk scratch allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bulk scratch bytes");
});

Deno.test("RankSelectBitVector matches scalar randomized references", () => {
  let state = 0x6d2b_79f5;
  for (const length of [0, 1, 127, 128, 511, 512, 513, 4099]) {
    const expected: number[] = [];
    for (let position = 0; position < length; position++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 7) === 0) expected.push(position);
    }
    using bits = RankSelectBitVector.from(length, expected);
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

Deno.test("RankSelectBitVector using lifecycle returns allocator storage", () => {
  const before = RankSelectBitVector.allocatorStats();
  {
    using bits = RankSelectBitVector.from(1_000_000, [1, 10, 999_999]);
    assertEquals(bits.rank1(1_000_000), 3, "live rank");
  }
  const after = RankSelectBitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("FixedBitSet handles boundaries and set algebra", () => {
  const left = FixedBitSet.from(130, [0, 31, 32, 63, 64, 127, 129]);
  const right = FixedBitSet.from(130, [1, 31, 63, 65, 127]);
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

Deno.test("FixedBitSet validates capacity and ignores padded tail bits", () => {
  const bits = new FixedBitSet(33).insert(32);
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

Deno.test("FixedBitSet storage remains intact across scratch-memory kernels", () => {
  const bits = FixedBitSet.from(1024, [0, 511, 1023]);
  const input = new Uint8Array(4096).fill(0x61);
  assertEquals(findByte(input, 0x7a), -1, "scratch scan");
  assertEquals(bits.toArray().join(","), "0,511,1023", "persistent storage");

  // Allocate after scratch use as well, since the regions grow independently.
  const later = FixedBitSet.from(65_537, [65_536]);
  assertEquals(later.countOnes(), 1, "allocation after scratch");
});

Deno.test("FixedBitSet SIMD operations match Set on randomized inputs", () => {
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
    const left = FixedBitSet.from(capacity, leftSet);
    const right = FixedBitSet.from(capacity, rightSet);
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

Deno.test("FixedBitSet dispose reuses storage and reports allocator state", () => {
  const before = FixedBitSet.allocatorStats();
  for (let iteration = 0; iteration < 10_000; iteration++) {
    FixedBitSet.from(4096, [0, 4095]).dispose();
  }
  const after = FixedBitSet.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bitset live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bitset live bytes");
  if (after.reservedBytes > before.reservedBytes + 512) {
    throw new Error(
      `bitset storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
  const disposed = new FixedBitSet(64);
  disposed.dispose();
  let threw = false;
  try {
    disposed.countOnes();
  } catch (error) {
    threw = error instanceof Error && error.message.includes("disposed");
  }
  assertEquals(threw, true, "bitset use after dispose");
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
