import { afterAll, bench, describe } from "vitest";
import {
  FlatHashMapFixed16U32,
  FlatHashSetFixed16,
} from "../../packages/jsimd/src/flat-hash-fixed16/mod.ts";

const LENGTH = 131_072;
const QUERY_LENGTH = 65_536;
let sink = 0;

function writeKey(output: Uint8Array, offset: number, seed: number): void {
  new DataView(output.buffer, output.byteOffset + offset, 16).setUint32(0, seed, true);
  let state = seed >>> 0;
  for (let index = 4; index < 16; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[offset + index] = state >>> 24;
  }
}

function hex(input: Uint8Array, offset: number): string {
  let output = "";
  for (let index = 0; index < 16; index++) {
    output += input[offset + index]!.toString(16).padStart(2, "0");
  }
  return output;
}

const keys = new Uint8Array(LENGTH * 16);
const values = new Uint32Array(LENGTH);
for (let index = 0; index < LENGTH; index++) {
  writeKey(keys, index * 16, index);
  values[index] = Math.imul(index, 3) >>> 0;
}
const queries = new Uint8Array(QUERY_LENGTH * 16);
for (let index = 0; index < QUERY_LENGTH; index++) {
  writeKey(queries, index * 16, index & 1 ? index * 2 : LENGTH + index);
}
const keyStrings = Array.from({ length: LENGTH }, (_, index) => hex(keys, index * 16));
const queryStrings = Array.from({ length: QUERY_LENGTH }, (_, index) => hex(queries, index * 16));

describe("FlatHashMapFixed16U32 lookup", () => {
  const flat = new FlatHashMapFixed16U32(LENGTH).insertMany(keys, values);
  const native = new Map<string, number>();
  for (let index = 0; index < LENGTH; index++) native.set(keyStrings[index]!, values[index]!);
  const output = new Uint32Array(QUERY_LENGTH);
  const present = new Uint8Array(QUERY_LENGTH);
  afterAll(() => flat[Symbol.dispose]());

  bench("Fixed16 map lookupMany", () => {
    sink ^= flat.lookupMany(queries, output, present);
  });
  bench("Map<string, number> get loop", () => {
    let found = 0;
    for (const key of queryStrings) found += Number(native.get(key) !== undefined);
    sink ^= found;
  });
});

describe("FlatHashSetFixed16 lookup", () => {
  const flat = new FlatHashSetFixed16(LENGTH).addMany(keys);
  const native = new Set(keyStrings);
  const present = new Uint8Array(QUERY_LENGTH);
  afterAll(() => flat[Symbol.dispose]());

  bench("Fixed16 set lookupMany", () => {
    sink ^= flat.lookupMany(queries, present);
  });
  bench("Set<string> has loop", () => {
    let found = 0;
    for (const key of queryStrings) found += Number(native.has(key));
    sink ^= found;
  });
});
