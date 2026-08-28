import { ByteKeyFlatHashMapU32 } from "../byte-key-flat-hash/mod.ts";
import { assertEquals } from "../../test/assert.ts";

function byteKey(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

Deno.test("ByteKeyFlatHashMapU32 distinguishes arbitrary byte keys", () => {
  using map = new ByteKeyFlatHashMapU32();
  const prefix = new Uint8Array(33).fill(0x61);
  const left = prefix.slice();
  const right = prefix.slice();
  right[32] = 0x62;
  map.set(new Uint8Array(), 1).set(byteKey(0, 1, 0, 2), 2).set(left, 3).set(right, 4);
  map.set(left, 30);
  assertEquals(map.size, 4, "map size");
  assertEquals(map.get(new Uint8Array()), 1, "empty key");
  assertEquals(map.get(byteKey(0, 1, 0, 2)), 2, "embedded zeros");
  assertEquals(map.get(left), 30, "overwrite");
  assertEquals(map.get(right), 4, "tail distinguishes key");
  assertEquals(map.get(byteKey(9)), undefined, "missing");
});

Deno.test("ByteKeyFlatHashMapU32 batches concatenated keys with offsets", () => {
  const keys = byteKey(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const offsets = Uint32Array.of(0, 0, 1, 4, 9);
  const values = Uint32Array.of(10, 20, 30, 40);
  using map = new ByteKeyFlatHashMapU32(16);
  map.insertMany(keys, offsets, values);
  const queries = byteKey(2, 3, 4, 99, 1, 5, 6, 7, 8, 9);
  const queryOffsets = Uint32Array.of(0, 3, 4, 5, 10);
  const output = new Uint32Array(4);
  const present = new Uint8Array(4);
  assertEquals(map.lookupMany(queries, queryOffsets, output, present), 3, "bulk hits");
  assertEquals(present.join(","), "1,0,1,1", "bulk presence");
  assertEquals(output.join(","), "30,0,20,40", "bulk values");
});

Deno.test("ByteKeyFlatHashMapU32 grows, deletes, clears, and releases using-owned storage", () => {
  const before = ByteKeyFlatHashMapU32.allocatorStats();
  {
    using map = new ByteKeyFlatHashMapU32(16);
    for (let index = 0; index < 5_000; index++) {
      const key = new Uint8Array(12);
      new DataView(key.buffer).setUint32(0, index, true);
      key.fill(index & 0xff, 4);
      map.set(key, index);
    }
    assertEquals(map.size, 5_000, "grown size");
    const key = new Uint8Array(12);
    new DataView(key.buffer).setUint32(0, 4_999, true);
    key.fill(4_999 & 0xff, 4);
    assertEquals(map.get(key), 4_999, "grown lookup");
    assertEquals(map.delete(key), true, "delete existing");
    assertEquals(map.has(key), false, "deleted missing");
    map.clear();
    assertEquals(map.size, 0, "clear size");
  }
  const after = ByteKeyFlatHashMapU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("ByteKeyFlatHashMapU32 matches Map for randomized variable-length batches", () => {
  let state = 0x8bad_f00d;
  const chunks: Uint8Array[] = [];
  const offsets = new Uint32Array(2_001);
  const values = new Uint32Array(2_000);
  const expected = new Map<string, number>();
  let byteLength = 0;
  for (let index = 0; index < values.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const key = new Uint8Array(state % 65);
    for (let byte = 0; byte < key.length; byte++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      key[byte] = state >>> 24;
    }
    chunks.push(key);
    byteLength += key.length;
    offsets[index + 1] = byteLength;
    values[index] = Math.imul(index, 17) >>> 0;
    expected.set(Array.from(key).join(","), values[index]!);
  }
  const bytes = new Uint8Array(byteLength);
  let cursor = 0;
  for (const key of chunks) {
    bytes.set(key, cursor);
    cursor += key.length;
  }
  using map = new ByteKeyFlatHashMapU32(16);
  map.insertMany(bytes, offsets, values);
  assertEquals(map.size, expected.size, "deduplicated randomized size");
  const output = new Uint32Array(values.length);
  const present = new Uint8Array(values.length);
  assertEquals(map.lookupMany(bytes, offsets, output, present), values.length, "all batch hits");
  for (let index = 0; index < values.length; index++) {
    assertEquals(present[index], 1, `present ${index}`);
    assertEquals(
      output[index],
      expected.get(Array.from(chunks[index]!).join(",")),
      `value ${index}`,
    );
  }
});
