import { afterAll, bench, describe } from "vitest";
import { StaticMphfBytes } from "./prototype/mod.ts";

const LENGTH = 65_536;
const QUERY_COUNT = 4096;
const offsets = new Uint32Array(LENGTH + 1);
const keys: Uint8Array[] = [];
const strings: string[] = [];
let total = 0;
for (let index = 0; index < LENGTH; index++) {
  const key = new Uint8Array(8 + (index % 25));
  new DataView(key.buffer).setUint32(0, index, true);
  for (let byte = 4; byte < key.length; byte++) key[byte] = (index * 31 + byte * 17) & 0xff;
  keys.push(key);
  strings.push(toHex(key));
  total += key.length;
  offsets[index + 1] = total;
}
const bytes = new Uint8Array(total);
for (let index = 0; index < LENGTH; index++) bytes.set(keys[index]!, offsets[index]);
const native = new Set(strings);
const queryKeys: Uint8Array[] = [];
const queryStrings: string[] = [];
for (let index = 0; index < QUERY_COUNT; index++) {
  const key = keys[(index * 65_537 + 17) & (LENGTH - 1)]!.slice();
  if ((index & 1) !== 0) key[0] ^= 0x80;
  queryKeys.push(key);
  queryStrings.push(toHex(key));
}
const queryOffsets = new Uint32Array(QUERY_COUNT + 1);
let queryTotal = 0;
for (let index = 0; index < QUERY_COUNT; index++) {
  queryTotal += queryKeys[index]!.length;
  queryOffsets[index + 1] = queryTotal;
}
const queryBytes = new Uint8Array(queryTotal);
for (let index = 0; index < QUERY_COUNT; index++) {
  queryBytes.set(queryKeys[index]!, queryOffsets[index]);
}
let sink = 0;

describe("StaticMphfBytes lookup", () => {
  const mphf = StaticMphfBytes.fromBytes(bytes, offsets);
  const output = new Int32Array(QUERY_COUNT);
  afterAll(() => mphf[Symbol.dispose]());

  bench("MPHF lookupMany x4096", () => {
    sink ^= mphf.lookupMany(queryBytes, queryOffsets, output);
  });
  bench("Set<string>.has x4096 (pre-encoded)", () => {
    let found = 0;
    for (const key of queryStrings) found += Number(native.has(key));
    sink ^= found;
  });
  bench("Set<string>.has x4096 (encode query)", () => {
    let found = 0;
    for (const key of queryKeys) found += Number(native.has(toHex(key)));
    sink ^= found;
  });
  bench("MPHF lookup x4096", () => {
    for (const key of queryKeys) sink ^= mphf.lookup(key);
  });
});

describe("StaticMphfBytes construction", () => {
  const buildOffsets = offsets.subarray(0, 16_385);
  const buildBytes = bytes.subarray(0, buildOffsets[buildOffsets.length - 1]);
  const buildStrings = strings.slice(0, 16_384);
  bench("MPHF build 16384", () => {
    using mphf = StaticMphfBytes.fromBytes(buildBytes, buildOffsets);
    sink ^= mphf.length;
  });
  bench("Set<string> build 16384 (pre-encoded)", () => {
    sink ^= new Set(buildStrings).size;
  });
});

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
