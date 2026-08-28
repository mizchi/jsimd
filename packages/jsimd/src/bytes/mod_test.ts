import { compare, equals, indexOf, indexOfNonAscii, lastIndexOf } from "../bytes/mod.ts";
import { assertEquals } from "../../test/assert.ts";

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

Deno.test("indexOf matches Uint8Array#indexOf across SIMD boundaries", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 4096]) {
    for (const hit of [-1, 0, 1, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x5a;
      assertEquals(indexOf(input, 0x5a), input.indexOf(0x5a), `length=${length}, hit=${hit}`);
    }
  }
});

Deno.test("indexOf preserves view-relative bounds", () => {
  const input = new Uint8Array(128).fill(0x61);
  input[80] = 0x5a;
  assertEquals(indexOf(input, 0x5a, 32, 96), 80, "bounded hit");
  assertEquals(indexOf(input, 0x5a, 0, 64), -1, "bounded miss");
});

Deno.test("lastIndexOf matches Uint8Array#lastIndexOf", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 4096]) {
    for (const hit of [-1, 0, 1, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x5a;
      assertEquals(
        lastIndexOf(input, 0x5a),
        input.lastIndexOf(0x5a),
        `length=${length}, hit=${hit}`,
      );
    }
  }
});

Deno.test("indexOfNonAscii returns the first non-ASCII offset", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 127, 128, 129, 4096]) {
    for (const hit of [-1, 0, 15, 16, length - 1]) {
      if (hit >= length) continue;
      const input = new Uint8Array(length).fill(0x61);
      if (hit >= 0) input[hit] = 0x80;
      const expected = input.findIndex((byte) => byte >= 0x80);
      assertEquals(indexOfNonAscii(input), expected, `length=${length}, hit=${hit}`);
    }
  }
});

Deno.test("equals matches equal-length byte semantics", () => {
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 127, 128, 129, 4096]) {
    const left = new Uint8Array(length).fill(0x61);
    const right = left.slice();
    assertEquals(equals(left, right), true, `equal length=${length}`);
    if (length > 0) {
      right[length - 1] = 0x62;
      assertEquals(equals(left, right), false, `different length=${length}`);
    }
  }
  assertEquals(equals(new Uint8Array(1), new Uint8Array(2)), false, "different lengths");
});

Deno.test("compare matches byte-wise lexicographical ordering", () => {
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
    assertEquals(Math.sign(compare(left, right)), Math.sign(expected), "lexical compare");
  }
});

Deno.test("indexOf matches scalar search", () => {
  for (const inputLength of [0, 1, 15, 16, 17, 127, 128, 129, 4096]) {
    for (const pattern of [[], [0x61], [0x61, 0x62], [0x61, 0x61, 0x62]]) {
      const input = new Uint8Array(inputLength).fill(0x61);
      if (inputLength > 0) input[inputLength - 1] = 0x62;
      const needle = new Uint8Array(pattern);
      assertEquals(
        indexOf(input, needle),
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
      indexOf(input, pattern),
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
      Math.sign(compare(input, other)),
      Math.sign(expected),
      `random compare trial=${trial}`,
    );
  }
});
