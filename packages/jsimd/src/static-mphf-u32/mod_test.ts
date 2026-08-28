import { StaticMphfU32, StaticMphfU32Builder } from "../static-mphf-u32/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("StaticMphfU32 maps every known key to a unique dense ID", () => {
  const keys = new Uint32Array([0, 1, 7, 42, 65_536, 0x8000_0000, 0xffff_ffff]);
  using index = StaticMphfU32.fromUint32Array(keys);
  assertEquals(index.length, keys.length, "length");
  const ids = new Set<number>();
  for (const key of keys) {
    const id = index.lookup(key);
    if (id < 0 || id >= keys.length) throw new Error(`invalid ID ${id} for ${key}`);
    ids.add(id);
  }
  assertEquals(ids.size, keys.length, "unique IDs");
  assertEquals(index.has(123_456_789), false, "unknown key");
  assertEquals(index.fingerprintBits, 16, "fingerprint bits");
});

Deno.test("StaticMphfU32Builder freezes independent snapshots", () => {
  const builder = new StaticMphfU32Builder();
  builder.add(10).add(20).add(30);
  using first = builder.freeze();
  builder.add(40);
  using second = builder.freeze();
  assertEquals(first.length, 3, "first length");
  assertEquals(first.has(40), false, "first snapshot");
  assertEquals(second.length, 4, "second length");
  assertEquals(second.has(40), true, "second snapshot");
});

Deno.test("StaticMphfU32 batches membership and dense ID lookup", () => {
  const keys = Uint32Array.from({ length: 4096 }, (_, index) => Math.imul(index + 1, 0x9e37_79b1));
  using index = StaticMphfU32.fromUint32Array(keys);
  const queries = new Uint32Array([keys[0]!, 123, keys[777]!, 456, keys[4095]!]);
  const ids = new Int32Array(queries.length);
  assertEquals(index.lookupMany(queries, ids), 3, "found count");
  assertEquals(ids[1], -1, "first miss");
  assertEquals(ids[3], -1, "second miss");
  assertEquals(index.lookup(keys[0]!), ids[0], "first ID");
  assertEquals(index.lookup(keys[777]!), ids[2], "middle ID");
  assertEquals(index.lookup(keys[4095]!), ids[4], "last ID");
});

Deno.test("StaticMphfU32 handles empty indexes and every four-query tail", () => {
  using empty = StaticMphfU32.from([]);
  const emptyQueries = new Uint32Array([1, 2, 3]);
  const emptyOutput = new Int32Array(emptyQueries.length);
  assertEquals(empty.lookupMany(emptyQueries, emptyOutput), 0, "empty found count");
  assertEquals(emptyOutput.join(","), "-1,-1,-1", "empty output");

  const keys = Uint32Array.from({ length: 128 }, (_, index) => Math.imul(index + 1, 0x85eb_ca6b));
  using index = StaticMphfU32.fromUint32Array(keys);
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 15, 16, 17]) {
    const queries = Uint32Array.from(
      { length },
      (_, query) => (query & 1) === 0 ? keys[query & 127]! : query,
    );
    const expected = Int32Array.from(queries, (key) => index.lookup(key));
    const actual = new Int32Array(length);
    const expectedFound = expected.reduce((count, id) => count + Number(id >= 0), 0);
    assertEquals(index.lookupMany(queries, actual), expectedFound, `found n=${length}`);
    assertEquals(actual.join(","), expected.join(","), `IDs n=${length}`);
  }
});

Deno.test("StaticMphfU32 rejects duplicate and invalid construction keys", () => {
  for (const values of [[1, 2, 1], [-1], [0x1_0000_0000]]) {
    let threw = false;
    try {
      StaticMphfU32.from(values);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assertEquals(threw, true, `invalid ${values}`);
  }
});

Deno.test("StaticMphfU32 matches randomized known keys and rejects sampled misses", () => {
  const keys = Uint32Array.from(
    { length: 16_384 },
    (_, index) => Math.imul(index + 1, 0x9e37_79b1) >>> 0,
  );
  using index = StaticMphfU32.fromUint32Array(keys);
  const ids = new Uint8Array(keys.length);
  for (const key of keys) {
    const id = index.lookup(key);
    if (id < 0 || ids[id] !== 0) throw new Error(`missing or duplicate ID for ${key}`);
    ids[id] = 1;
  }
  let falsePositives = 0;
  for (let value = 0; value < 10_000; value++) {
    if (index.has(value)) falsePositives++;
  }
  if (falsePositives > 2) {
    throw new Error(`unexpected fingerprint false positives: ${falsePositives}`);
  }
});

Deno.test("StaticMphfU32 using lifecycle reaches an allocator plateau", () => {
  const values = Uint32Array.from(
    { length: 1024 },
    (_, index) => Math.imul(index + 1, 0x85eb_ca6b),
  );
  const before = StaticMphfU32.allocatorStats();
  for (let iteration = 0; iteration < 1000; iteration++) {
    using index = StaticMphfU32.fromUint32Array(values);
    assertEquals(index.has(values[iteration & 1023]!), true, "live index");
  }
  const after = StaticMphfU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
  if (after.reservedBytes > before.reservedBytes + 8192) {
    throw new Error(
      `MPHF storage did not plateau: ${before.reservedBytes} -> ${after.reservedBytes}`,
    );
  }
});
