import { afterAll, bench, describe } from "vitest";
import { ByteKeyFlatHashMapU32 } from "../../src/byte-key-flat-hash/mod.ts";

const LENGTH = 131_072;
const QUERY_LENGTH = 65_536;
const POINT_QUERY_LENGTH = 4_096;
let sink = 0;

function makeKey(seed: number): Uint8Array {
  let state = seed >>> 0;
  const key = new Uint8Array(8 + (state % 33));
  new DataView(key.buffer).setUint32(0, seed, true);
  for (let index = 4; index < key.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    key[index] = state >>> 24;
  }
  return key;
}

function flatten(keys: readonly Uint8Array[]): { bytes: Uint8Array; offsets: Uint32Array } {
  const offsets = new Uint32Array(keys.length + 1);
  let length = 0;
  for (let index = 0; index < keys.length; index++) {
    length += keys[index]!.length;
    offsets[index + 1] = length;
  }
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const key of keys) {
    bytes.set(key, cursor);
    cursor += key.length;
  }
  return { bytes, offsets };
}

function hex(input: Uint8Array): string {
  let output = "";
  for (const byte of input) output += byte.toString(16).padStart(2, "0");
  return output;
}

const keyList = Array.from({ length: LENGTH }, (_, index) => makeKey(index));
const queryList = Array.from(
  { length: QUERY_LENGTH },
  (_, index) => makeKey(index & 1 ? index * 2 : LENGTH + index),
);
const keys = flatten(keyList);
const queries = flatten(queryList);
const values = Uint32Array.from({ length: LENGTH }, (_, index) => Math.imul(index, 3) >>> 0);
const keyStrings = keyList.map(hex);
const queryStrings = queryList.map(hex);

describe("ByteKeyFlatHashMapU32 lookup", () => {
  const flat = new ByteKeyFlatHashMapU32(LENGTH).insertMany(keys.bytes, keys.offsets, values);
  const native = new Map<string, number>();
  for (let index = 0; index < LENGTH; index++) native.set(keyStrings[index]!, values[index]!);
  const output = new Uint32Array(QUERY_LENGTH);
  const present = new Uint8Array(QUERY_LENGTH);
  afterAll(() => flat[Symbol.dispose]());

  bench("byte-key map lookupMany", () => {
    sink ^= flat.lookupMany(queries.bytes, queries.offsets, output, present);
  });
  bench("Map<string, number> get loop", () => {
    let found = 0;
    for (const key of queryStrings) found += Number(native.get(key) !== undefined);
    sink ^= found;
  });
  bench("byte-key map individual get", () => {
    let found = 0;
    for (let index = 0; index < POINT_QUERY_LENGTH; index++) {
      found += Number(flat.get(queryList[index]!) !== undefined);
    }
    sink ^= found;
  });
  bench("Map<string, number> individual get", () => {
    let found = 0;
    for (let index = 0; index < POINT_QUERY_LENGTH; index++) {
      found += Number(native.get(queryStrings[index]!) !== undefined);
    }
    sink ^= found;
  });
});
