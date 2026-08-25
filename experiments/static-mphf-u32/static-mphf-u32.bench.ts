import { afterAll, bench, describe } from "vitest";
import { FlatHashSetU32 } from "../../src/flat-hash/mod.ts";
import { StaticMphfU32 } from "../../src/static-mphf-u32/mod.ts";

const LENGTH = 262_144;
const QUERY_COUNT = 4096;
let sink = 0;

const keys = Uint32Array.from(
  { length: LENGTH },
  (_, index) => Math.imul(index + 1, 0x9e37_79b1) >>> 0,
);
const native = new Set(keys);
const queries = new Uint32Array(QUERY_COUNT);
let miss = 0;
for (let index = 0; index < queries.length; index++) {
  if ((index & 1) === 0) {
    queries[index] = keys[Math.imul(index + 17, 65_537) & (LENGTH - 1)]!;
  } else {
    while (native.has(miss)) miss++;
    queries[index] = miss++;
  }
}

describe("StaticMphfU32 lookup", () => {
  const mphf = StaticMphfU32.fromUint32Array(keys);
  const flat = FlatHashSetU32.from(keys);
  const ids = new Int32Array(queries.length);
  const present = new Uint8Array(queries.length);

  afterAll(() => {
    flat[Symbol.dispose]();
    mphf[Symbol.dispose]();
  });

  bench("MPHF lookupMany x4096", () => {
    sink ^= mphf.lookupMany(queries, ids);
  });
  bench("FlatHash lookupMany x4096", () => {
    sink ^= flat.lookupMany(queries, present);
  });
  bench("Set.has x4096", () => {
    let found = 0;
    for (const key of queries) found += Number(native.has(key));
    sink ^= found;
  });
  bench("MPHF lookup x4096", () => {
    for (const key of queries) sink ^= mphf.lookup(key);
  });
  bench("FlatHash has x4096", () => {
    for (const key of queries) sink ^= Number(flat.has(key));
  });
});

describe("StaticMphfU32 construction", () => {
  const buildKeys = keys.subarray(0, 16_384);

  bench("MPHF build 16384", () => {
    using mphf = StaticMphfU32.fromUint32Array(buildKeys);
    sink ^= mphf.length;
  });
  bench("FlatHash build 16384", () => {
    using flat = FlatHashSetU32.from(buildKeys);
    sink ^= flat.size;
  });
  bench("Set build 16384", () => {
    const set = new Set(buildKeys);
    sink ^= set.size;
  });
});
