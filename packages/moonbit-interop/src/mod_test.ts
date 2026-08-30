import {
  arrayViewFind,
  arrayViewFindByte,
  arrayViewRevFind,
  arrayViewRevFindByte,
  compare,
  equal,
  find,
  findByte,
  findNonAscii,
  revFind,
  revFindByte,
  stringViewCompare,
  stringViewFind,
  stringViewFindCodeUnit,
  stringViewRevFind,
  stringViewRevFindCodeUnit,
} from "./mod.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message ?? "assertEquals"}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("find and findByte preserve MoonBit byte offsets", () => {
  const input = new Uint8Array(4096).fill(0x61);
  input[2047] = 0x62;
  input[2048] = 0x63;
  assertEquals(findByte(input, 0x62), 2047);
  assertEquals(findByte(input, 0x7a), -1);
  assertEquals(find(input, new Uint8Array([0x62, 0x63])), 2047);
  assertEquals(find(input, new Uint8Array()), 0);
});

Deno.test("find accepts offset views", () => {
  const source = new Uint8Array([0xff, 0x62, 0x63, 0xff]);
  const needle = source.subarray(1, 3);
  assertEquals(find(new Uint8Array([0x61, 0x62, 0x63]), needle), 1);
});

Deno.test("revFind supports bytes and byte sequences", () => {
  const input = new TextEncoder().encode("abcabc");
  assertEquals(revFindByte(input, 0x62), 4);
  assertEquals(revFindByte(input, 0x7a), -1);
  assertEquals(revFind(input, new TextEncoder().encode("abc")), 3);
  assertEquals(revFind(input, new Uint8Array()), input.length);
  assertEquals(revFind(input, new TextEncoder().encode("xyz")), -1);
});

Deno.test("equal delegates byte equality", () => {
  assertEquals(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assertEquals(equal(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assertEquals(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

Deno.test("compare preserves MoonBit shortlex ordering", () => {
  assertEquals(compare(new Uint8Array([0x7a]), new Uint8Array([0x61, 0x61])), -1);
  assertEquals(compare(new Uint8Array([0x61, 0x61]), new Uint8Array([0x7a])), 1);
  assertEquals(compare(new Uint8Array([1, 2]), new Uint8Array([1, 3])), -1);
  assertEquals(compare(new Uint8Array([1, 4]), new Uint8Array([1, 3])), 1);
  assertEquals(compare(new Uint8Array([1, 2]), new Uint8Array([1, 2])), 0);
});

Deno.test("findNonAscii returns the first non-ASCII offset", () => {
  const input = new Uint8Array(4096).fill(0x61);
  input[4095] = 0xff;
  assertEquals(findNonAscii(input), 4095);
  assertEquals(findNonAscii(new Uint8Array([0x61, 0x62])), -1);
});

Deno.test("byte operations accept MoonBit BytesView without copying its surroundings", () => {
  const backing = new Uint8Array([0xff, 0xff, 0x61, 0x62, 0x63, 0x61, 0x62, 0xff]);
  const view = { buf: backing, start: 2, end: 7 };
  const patternBacking = new Uint8Array([0xff, 0x62, 0x63, 0xff]);
  const pattern = { buf: patternBacking, start: 1, end: 3 };
  assertEquals(findByte(view, 0x61), 0);
  assertEquals(find(view, pattern), 1);
  assertEquals(revFindByte(view, 0x61), 3);
  assertEquals(revFind(view, { buf: backing, start: 5, end: 7 }), 3);
  assertEquals(equal(view, { buf: backing.slice(), start: 2, end: 7 }), true);
  assertEquals(compare(view, { buf: backing, start: 2, end: 6 }), 1);
});

Deno.test("StringView operations preserve relative UTF-16 offsets and view bounds", () => {
  const target = { str: "xxab😀abyy", start: 2, end: 8 };
  const ab = { str: "_ab_", start: 1, end: 3 };
  assertEquals(stringViewFind(target, ab), 0);
  assertEquals(stringViewRevFind(target, ab), 4);
  assertEquals(stringViewFindCodeUnit(target, 0xd83d), 2);
  assertEquals(stringViewRevFindCodeUnit(target, 0x61), 4);
  assertEquals(stringViewFind(target, { str: "", start: 0, end: 0 }), 0);
  assertEquals(stringViewRevFind(target, { str: "", start: 0, end: 0 }), 6);
  assertEquals(stringViewFind(target, { str: "by", start: 0, end: 2 }), -1);
});

Deno.test("StringView comparison uses MoonBit shortlex ordering", () => {
  const abc = { str: "_abc_", start: 1, end: 4 };
  assertEquals(
    stringViewCompare({ str: "z", start: 0, end: 1 }, { str: "aa", start: 0, end: 2 }),
    -1,
  );
  assertEquals(stringViewCompare(abc, { str: "abd", start: 0, end: 3 }), -1);
  assertEquals(stringViewCompare(abc, { str: "abc", start: 0, end: 3 }), 0);
});

Deno.test("ArrayView byte searches preserve relative offsets", () => {
  const fixed = [0xff, 0xff, 0x61, 0x62, 0x63, 0x61, 0x62, 0xff];
  const view = { buf: fixed, start: 2, end: 7 };
  const pattern = { buf: [0xff, 0x62, 0x63, 0xff], start: 1, end: 3 };
  assertEquals(arrayViewFindByte(view, 0x61), 0);
  assertEquals(arrayViewFind(view, pattern), 1);
  assertEquals(arrayViewRevFindByte(view, 0x61), 3);
  assertEquals(arrayViewRevFind(view, { buf: [0x61, 0x62], start: 0, end: 2 }), 3);
});
