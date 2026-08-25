import {
  bytesEqual,
  findByte,
  findNonAscii,
  indexOfSubarray,
  jsonTokenStarts,
  lexicalCompare,
  reverseFindByte,
} from "./mod.ts";
import { FixedBitSet } from "./bitset.ts";
import { SimdFloat32Vector } from "./f32-vector.ts";

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
