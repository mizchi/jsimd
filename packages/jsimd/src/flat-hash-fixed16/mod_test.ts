import { FlatHashMapFixed16U32, FlatHashSetFixed16 } from "../flat-hash-fixed16/mod.ts";
import { assertEquals } from "../../test/assert.ts";

function fixed16(seed: number): Uint8Array {
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, seed, true);
  let state = seed >>> 0;
  for (let index = 4; index < 16; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    key[index] = state >>> 24;
  }
  return key;
}

Deno.test("FlatHashMapFixed16U32 compares complete 16-byte keys", () => {
  using map = new FlatHashMapFixed16U32();
  const first = fixed16(1);
  const second = first.slice();
  second[15] ^= 1;
  map.set(first, 10).set(second, 20).set(first, 30);
  assertEquals(map.size, 2, "map size");
  assertEquals(map.get(first), 30, "overwrite");
  assertEquals(map.get(second), 20, "tail distinguishes key");
  assertEquals(map.get(fixed16(99)), undefined, "missing");
  assertEquals(map.delete(first), true, "delete existing");
  assertEquals(map.has(first), false, "deleted missing");
});

Deno.test("FlatHashMapFixed16U32 batches insertion and lookup", () => {
  const count = 2_000;
  const keys = new Uint8Array(count * 16);
  const values = new Uint32Array(count);
  for (let index = 0; index < count; index++) {
    keys.set(fixed16(index), index * 16);
    values[index] = index * 3;
  }
  using map = new FlatHashMapFixed16U32(16);
  map.insertMany(keys, values);
  const queries = new Uint8Array(4 * 16);
  queries.set(keys.subarray(0, 16), 0);
  queries.set(keys.subarray(999 * 16, 1_000 * 16), 16);
  queries.set(fixed16(99_999), 32);
  queries.set(keys.subarray(1_999 * 16, 2_000 * 16), 48);
  const output = new Uint32Array(4);
  const present = new Uint8Array(4);
  assertEquals(map.lookupMany(queries, output, present), 3, "bulk hits");
  assertEquals(present.join(","), "1,1,0,1", "presence");
  assertEquals(output.join(","), "0,2997,0,5997", "values");
});

Deno.test("FlatHashSetFixed16 derives set operations from the fixed-key table", () => {
  using set = FlatHashSetFixed16.from([fixed16(1), fixed16(2), fixed16(1)]);
  assertEquals(set.size, 2, "deduplicated size");
  assertEquals(set.has(fixed16(2)), true, "present key");
  assertEquals(set.delete(fixed16(2)), true, "delete");
  assertEquals(set.has(fixed16(2)), false, "deleted key");
  const queries = new Uint8Array(3 * 16);
  queries.set(fixed16(1), 0);
  queries.set(fixed16(2), 16);
  queries.set(fixed16(3), 32);
  const present = new Uint8Array(3);
  assertEquals(set.lookupMany(queries, present), 1, "set batch hits");
  assertEquals(present.join(","), "1,0,0", "set batch presence");
});

Deno.test("fixed16 hash tables release grown storage with using", () => {
  const before = FlatHashMapFixed16U32.allocatorStats();
  {
    using map = new FlatHashMapFixed16U32();
    for (let index = 0; index < 5_000; index++) map.set(fixed16(index), index);
    assertEquals(map.size, 5_000, "grown size");
  }
  const after = FlatHashMapFixed16U32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
