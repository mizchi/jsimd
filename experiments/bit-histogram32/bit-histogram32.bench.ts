import { afterAll, bench, describe } from "vitest";
import { BitHistogram32, bitHistogram32 } from "../../src/bit-histogram32/mod.ts";

const LENGTH = 262_144;
const dense = Uint32Array.from(
  { length: LENGTH },
  (_, index) => Math.imul(index + 1, 0x9e37_79b1) >>> 0,
);
const sparse = Uint32Array.from(
  { length: LENGTH },
  (_, index) =>
    ((1 << (index & 31)) | (1 << ((index + 11) & 31)) | (1 << ((index + 23) & 31))) >>> 0,
);
const output = new Uint32Array(32);
let sink = 0;

function scalarFixed(values: Uint32Array, counts: Uint32Array): void {
  counts.fill(0);
  for (const value of values) {
    for (let bit = 0; bit < 32; bit++) counts[bit] += (value >>> bit) & 1;
  }
}

function scalarSetBits(values: Uint32Array, counts: Uint32Array): void {
  counts.fill(0);
  for (const value of values) {
    let remaining = value;
    while (remaining !== 0) {
      const bit = 31 - Math.clz32((remaining & -remaining) >>> 0);
      counts[bit]++;
      remaining = (remaining & (remaining - 1)) >>> 0;
    }
  }
}

describe.each(
  [
    ["dense random", dense],
    ["sparse 3-bit flags", sparse],
  ] as const,
)("BitHistogram32 %s 256K", (_name, values) => {
  const resident = new BitHistogram32();
  afterAll(() => resident[Symbol.dispose]());

  bench("copy-inclusive bitHistogram32", () => {
    bitHistogram32(values, output);
    sink ^= output[0]!;
  });

  bench("reused BitHistogram32", () => {
    resident.reset().add(values).writeInto(output);
    sink ^= output[0]!;
  });

  bench("JavaScript fixed 32-bit loop", () => {
    scalarFixed(values, output);
    sink ^= output[0]!;
  });

  bench("JavaScript set-bit loop", () => {
    scalarSetBits(values, output);
    sink ^= output[0]!;
  });
});

describe("BitHistogram32 small dense 64", () => {
  const values = dense.subarray(0, 64);
  bench("copy-inclusive bitHistogram32", () => {
    bitHistogram32(values, output);
    sink ^= output[0]!;
  });
  bench("JavaScript fixed 32-bit loop", () => {
    scalarFixed(values, output);
    sink ^= output[0]!;
  });
  bench("JavaScript set-bit loop", () => {
    scalarSetBits(values, output);
    sink ^= output[0]!;
  });
});

describe("BitHistogram32 single word", () => {
  const values = dense.subarray(0, 1);
  bench("copy-inclusive bitHistogram32", () => {
    bitHistogram32(values, output);
    sink ^= output[0]!;
  });
  bench("JavaScript fixed 32-bit loop", () => {
    scalarFixed(values, output);
    sink ^= output[0]!;
  });
  bench("JavaScript set-bit loop", () => {
    scalarSetBits(values, output);
    sink ^= output[0]!;
  });
});
