import { FlatHashMapU32U32, FlatHashMapU64U32, FlatHashSetU32 } from "../flat-hash/mod.ts";
import { StaticMphfU32 } from "../static-mphf-u32/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("FlatHashSetU32 supports Uint32 keys, tombstones, and growth", () => {
  using set = new FlatHashSetU32(16);
  set.insert(0).insert(0xffff_ffff).insert(42).insert(42);
  assertEquals(set.size, 3, "deduplicated size");
  assertEquals(set.has(0), true, "zero key");
  assertEquals(set.has(0xffff_ffff), true, "maximum key");
  assertEquals(set.delete(42), true, "delete existing");
  assertEquals(set.delete(42), false, "delete missing");
  for (let key = 1; key <= 2_000; key++) set.insert(Math.imul(key, 65_537) >>> 0);
  assertEquals(set.size, 2_002, "size after growth");
  for (let key = 1; key <= 2_000; key += 37) {
    assertEquals(set.has(Math.imul(key, 65_537) >>> 0), true, `grown key ${key}`);
  }
  if (set.capacity < 2_002) throw new Error(`capacity did not grow: ${set.capacity}`);
});

Deno.test("FlatHashSetU32 batches inserts and reusable lookups", () => {
  using set = FlatHashSetU32.from([1, 3, 5]);
  set.insertMany(new Uint32Array([5, 7, 9, 0xffff_ffff]));
  const queries = new Uint32Array([0, 1, 7, 8, 9, 0xffff_ffff]);
  const present = new Uint8Array(queries.length);
  assertEquals(set.lookupMany(queries, present), 4, "bulk hit count");
  assertEquals(present.join(","), "0,1,1,0,1,1", "bulk presence");
});

Deno.test("FlatHashMapU32U32 stores and overwrites the complete Uint32 domain", () => {
  using map = new FlatHashMapU32U32();
  map.set(0, 0xffff_ffff).set(0xffff_ffff, 0).set(42, 10).set(42, 11);
  assertEquals(map.size, 3, "map size");
  assertEquals(map.get(0), 0xffff_ffff, "maximum value");
  assertEquals(map.get(0xffff_ffff), 0, "zero value");
  assertEquals(map.get(42), 11, "overwrite");
  assertEquals(map.get(7), undefined, "missing value");
  assertEquals(map.delete(42), true, "map delete");
  assertEquals(map.has(42), false, "deleted key");
});

Deno.test("FlatHashMapU32U32 batches inserts and reusable lookups", () => {
  using map = new FlatHashMapU32U32(16);
  const keys = Uint32Array.from({ length: 2_000 }, (_, index) => Math.imul(index, 2_654_435_761));
  const values = Uint32Array.from({ length: keys.length }, (_, index) => index * 3);
  map.insertMany(keys, values);
  const queries = new Uint32Array([keys[0]!, keys[999]!, 123, keys[1_999]!]);
  const output = new Uint32Array(queries.length);
  const present = new Uint8Array(queries.length);
  assertEquals(map.lookupMany(queries, output, present), 3, "map bulk hits");
  assertEquals(present.join(","), "1,1,0,1", "map bulk presence");
  assertEquals(output[0], 0, "map first value");
  assertEquals(output[1], 2_997, "map middle value");
  assertEquals(output[3], 5_997, "map last value");
});

Deno.test("FlatHash tables match native references and release grown storage", () => {
  const setBefore = FlatHashSetU32.allocatorStats();
  const mapBefore = FlatHashMapU32U32.allocatorStats();
  {
    using set = new FlatHashSetU32();
    using map = new FlatHashMapU32U32();
    const referenceSet = new Set<number>();
    const referenceMap = new Map<number, number>();
    let state = 0xdead_beef;
    for (let index = 0; index < 10_000; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const key = state;
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = state;
      set.insert(key);
      map.set(key, value);
      referenceSet.add(key);
      referenceMap.set(key, value);
      if ((index & 7) === 0) {
        set.delete(key);
        map.delete(key);
        referenceSet.delete(key);
        referenceMap.delete(key);
      }
    }
    assertEquals(set.size, referenceSet.size, "random set size");
    assertEquals(map.size, referenceMap.size, "random map size");
    for (const key of referenceSet) assertEquals(set.has(key), true, `random set ${key}`);
    for (const [key, value] of referenceMap) {
      assertEquals(map.get(key), value, `random map ${key}`);
    }
  }
  const setAfter = FlatHashSetU32.allocatorStats();
  const mapAfter = FlatHashMapU32U32.allocatorStats();
  assertEquals(setAfter.liveAllocations, setBefore.liveAllocations, "set allocations");
  assertEquals(setAfter.liveBytes, setBefore.liveBytes, "set bytes");
  assertEquals(mapAfter.liveAllocations, mapBefore.liveAllocations, "map allocations");
  assertEquals(mapAfter.liveBytes, mapBefore.liveBytes, "map bytes");
});

Deno.test("FlatHash allocator reaches a reuse plateau after repeated growth", () => {
  const exercise = () => {
    using set = new FlatHashSetU32();
    using map = new FlatHashMapU32U32();
    const keys = Uint32Array.from({ length: 20_000 }, (_, index) => Math.imul(index, 0x9e37_79b1));
    const values = Uint32Array.from(keys, (key) => key ^ 0xa5a5_a5a5);
    set.insertMany(keys);
    map.insertMany(keys, values);
    set.clear().insertMany(keys);
    map.clear().insertMany(keys, values);
  };
  exercise();
  const plateau = FlatHashSetU32.allocatorStats();
  exercise();
  const repeated = FlatHashSetU32.allocatorStats();
  assertEquals(repeated.liveAllocations, 0, "plateau live allocations");
  assertEquals(repeated.liveBytes, 0, "plateau live bytes");
  assertEquals(repeated.reservedBytes, plateau.reservedBytes, "plateau reserved bytes");
});

Deno.test("FlatHashMapU64U32 distinguishes the complete unsigned 64-bit key space", () => {
  using map = new FlatHashMapU64U32();
  const entries = [
    [0n, 1],
    [1n, 2],
    [0xffff_ffffn, 3],
    [0x1_0000_0000n, 4],
    [0xffff_ffff_ffff_ffffn, 5],
  ] as const;
  for (const [key, value] of entries) map.set(key, value);
  assertEquals(map.size, entries.length, "size");
  for (const [key, value] of entries) assertEquals(map.get(key), value, `get ${key}`);
  map.set(0x1_0000_0000n, 99);
  assertEquals(map.size, entries.length, "update size");
  assertEquals(map.get(0x1_0000_0000n), 99, "updated value");
  assertEquals(map.has(9n), false, "missing key");
  assertEquals(map.delete(1n), true, "delete present");
  assertEquals(map.delete(1n), false, "delete absent");
});

Deno.test("FlatHashMapU64U32 batches BigUint64Array inserts and lookups", () => {
  const keys = BigUint64Array.from(
    { length: 10_000 },
    (_, index) => BigInt(index) * 0x9e37_79b9_7f4a_7c15n & 0xffff_ffff_ffff_ffffn,
  );
  const values = Uint32Array.from(keys, (_, index) => Math.imul(index, 17) >>> 0);
  using map = new FlatHashMapU64U32(keys.length);
  map.insertMany(keys, values);
  assertEquals(map.size, keys.length, "bulk size");
  const queries = new BigUint64Array([keys[1]!, 123n, keys[9999]!, 0xffffn]);
  const output = new Uint32Array(queries.length);
  const present = new Uint8Array(queries.length);
  assertEquals(map.lookupMany(queries, output, present), 2, "found count");
  assertEquals(present.join(","), "1,0,1,0", "presence");
  assertEquals(output[0], values[1], "first value");
  assertEquals(output[2], values[9999], "last value");
});

Deno.test("FlatHashMapU64U32 using lifecycle releases resized storage", () => {
  const before = FlatHashMapU64U32.allocatorStats();
  {
    using map = new FlatHashMapU64U32();
    for (let index = 0; index < 20_000; index++) {
      map.set(BigInt(index) << 33n | BigInt(index), index);
    }
    assertEquals(map.size, 20_000, "live map");
  }
  const after = FlatHashMapU64U32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("flat hash tables enumerate keys and entries into typed outputs", () => {
  using set = FlatHashSetU32.from([0, 7, 0xffff_ffff]);
  const setKeys = new Uint32Array(4).fill(123);
  assertEquals(set.keysInto(setKeys), 3, "set keys count");
  assertEquals(
    Array.from(setKeys.subarray(0, 3)).sort((a, b) => a - b).join(","),
    "0,7,4294967295",
    "set keys",
  );
  assertEquals(setKeys[3], 123, "set output tail");

  using map = FlatHashMapU32U32.from([[1, 10], [2, 20], [0xffff_ffff, 30]]);
  const mapKeys = new Uint32Array(3);
  const mapValues = new Uint32Array(3);
  assertEquals(map.entriesInto(mapKeys, mapValues), 3, "u32 map entries count");
  const restored = new Map<number, number>();
  for (let index = 0; index < 3; index++) restored.set(mapKeys[index]!, mapValues[index]!);
  assertEquals(restored.get(1), 10, "u32 entry one");
  assertEquals(restored.get(0xffff_ffff), 30, "u32 entry max");

  using u64 = FlatHashMapU64U32.from([[0n, 4], [0xffff_ffff_ffff_ffffn, 9]]);
  const u64Keys = new BigUint64Array(2);
  const u64Values = new Uint32Array(2);
  assertEquals(u64.entriesInto(u64Keys, u64Values), 2, "u64 map entries count");
  const restoredU64 = new Map<bigint, number>();
  for (let index = 0; index < 2; index++) restoredU64.set(u64Keys[index]!, u64Values[index]!);
  assertEquals(restoredU64.get(0xffff_ffff_ffff_ffffn), 9, "u64 entry max");
});

Deno.test("FlatHashSetU32 freezes into an independent StaticMphfU32", () => {
  using mutable = FlatHashSetU32.from([7, 11, 42, 1_000_000]);
  using frozen = StaticMphfU32.fromFlatHashSet(mutable);
  assertEquals(frozen.length, 4, "flat hash bridge length");
  for (const key of [7, 11, 42, 1_000_000]) {
    assertEquals(frozen.lookup(key) >= 0, true, `flat hash bridge key ${key}`);
  }
  mutable.delete(7);
  mutable.insert(99);
  assertEquals(frozen.lookup(7) >= 0, true, "MPHF snapshot keeps removed key");
  assertEquals(frozen.lookup(99), -1, "MPHF snapshot ignores later key");
});
