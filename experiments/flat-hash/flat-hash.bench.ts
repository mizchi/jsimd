import { afterAll, bench, describe } from "vitest";
import { FlatHashMapU32U32, FlatHashSetU32 } from "../../src/flat-hash/mod.ts";

const LENGTH = 262_144;
const QUERY_LENGTH = 131_072;
let sink = 0;

const keys = Uint32Array.from(
  { length: LENGTH },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const values = Uint32Array.from(keys, (key, index) => (key ^ index) >>> 0);
const queries = Uint32Array.from(
  { length: QUERY_LENGTH },
  (_, index) => index & 1 ? keys[index * 2]! : (keys[index * 2]! + 1) >>> 0,
);
const pointQueries = queries.subarray(0, 1_024);

function sortedCopy(input: Uint32Array): Uint32Array {
  return input.slice().sort();
}

function binaryHas(input: Uint32Array, key: number): boolean {
  let low = 0;
  let high = input.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const value = input[middle]!;
    if (value < key) low = middle + 1;
    else high = middle;
  }
  return low < input.length && input[low] === key;
}

describe("FlatHashSetU32 lookup", () => {
  const flat = new FlatHashSetU32(LENGTH).insertMany(keys);
  const native = new Set(keys);
  const sorted = sortedCopy(keys);
  const present = new Uint8Array(queries.length);

  afterAll(() => flat[Symbol.dispose]());

  bench("FlatHashSet lookupMany", () => {
    sink ^= flat.lookupMany(queries, present);
  });
  bench("Set<number> has loop", () => {
    let found = 0;
    for (const key of queries) found += Number(native.has(key));
    sink ^= found;
  });
  bench("sorted Uint32Array binary search", () => {
    let found = 0;
    for (const key of queries) found += Number(binaryHas(sorted, key));
    sink ^= found;
  });
});

describe("FlatHashMapU32U32 lookup", () => {
  const flat = new FlatHashMapU32U32(LENGTH).insertMany(keys, values);
  const native = new Map<number, number>();
  for (let index = 0; index < keys.length; index++) native.set(keys[index]!, values[index]!);
  const output = new Uint32Array(queries.length);
  const present = new Uint8Array(queries.length);

  afterAll(() => flat[Symbol.dispose]());

  bench("FlatHashMap lookupMany", () => {
    sink ^= flat.lookupMany(queries, output, present);
  });
  bench("Map<number, number> get loop", () => {
    let found = 0;
    for (const key of queries) found += Number(native.get(key) !== undefined);
    sink ^= found;
  });
});

describe("FlatHash point lookup boundary", () => {
  const flatSet = new FlatHashSetU32(LENGTH).insertMany(keys);
  const nativeSet = new Set(keys);
  const flatMap = new FlatHashMapU32U32(LENGTH).insertMany(keys, values);
  const nativeMap = new Map<number, number>();
  for (let index = 0; index < keys.length; index++) nativeMap.set(keys[index]!, values[index]!);

  afterAll(() => {
    flatMap[Symbol.dispose]();
    flatSet[Symbol.dispose]();
  });

  bench("FlatHashSet has x1024", () => {
    let found = 0;
    for (const key of pointQueries) found += Number(flatSet.has(key));
    sink ^= found;
  });
  bench("Set<number> has x1024", () => {
    let found = 0;
    for (const key of pointQueries) found += Number(nativeSet.has(key));
    sink ^= found;
  });
  bench("FlatHashMap get x1024", () => {
    let found = 0;
    for (const key of pointQueries) found += Number(flatMap.get(key) !== undefined);
    sink ^= found;
  });
  bench("Map<number, number> get x1024", () => {
    let found = 0;
    for (const key of pointQueries) found += Number(nativeMap.get(key) !== undefined);
    sink ^= found;
  });
});

describe("FlatHash bulk rebuild", () => {
  const flatSet = new FlatHashSetU32(LENGTH);
  const nativeSet = new Set<number>();
  const flatMap = new FlatHashMapU32U32(LENGTH);
  const nativeMap = new Map<number, number>();

  afterAll(() => {
    flatMap[Symbol.dispose]();
    flatSet[Symbol.dispose]();
  });

  bench("FlatHashSet clear + insertMany", () => {
    flatSet.clear().insertMany(keys);
    sink ^= flatSet.size;
  });
  bench("Set<number> clear + add loop", () => {
    nativeSet.clear();
    for (const key of keys) nativeSet.add(key);
    sink ^= nativeSet.size;
  });
  bench("FlatHashMap clear + insertMany", () => {
    flatMap.clear().insertMany(keys, values);
    sink ^= flatMap.size;
  });
  bench("Map<number, number> clear + set loop", () => {
    nativeMap.clear();
    for (let index = 0; index < keys.length; index++) {
      nativeMap.set(keys[index]!, values[index]!);
    }
    sink ^= nativeMap.size;
  });
});
