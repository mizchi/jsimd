import { FrozenByteMapU32, StaticMphfBytes, StaticMphfBytesBuilder } from "./prototype/mod.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function byteKey(...bytes: number[]): Uint8Array {
  return Uint8Array.of(...bytes);
}

function fixed16(value: number): Uint8Array {
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, value, true);
  return key;
}

Deno.test("archived StaticMphfBytes preserves exact membership and batch lookup", () => {
  const keys = byteKey(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const offsets = Uint32Array.of(0, 0, 1, 4, 9);
  using mphf = StaticMphfBytes.fromBytes(keys, offsets);
  const queries = byteKey(2, 3, 4, 99, 1, 5, 6, 7, 8, 9);
  const queryOffsets = Uint32Array.of(0, 3, 4, 5, 10);
  const output = new Int32Array(4);
  assert(mphf.lookupMany(queries, queryOffsets, output) === 3, "expected three hits");
  assert(output[1] === -1, "unknown key must miss");
  assert(new Set([output[0], output[2], output[3]]).size === 3, "IDs must be unique");
});

Deno.test("archived FrozenByteMapU32 preserves values", () => {
  using map = FrozenByteMapU32.from([
    [new Uint8Array(), 10],
    [byteKey(1), 20],
    [byteKey(2, 3, 4), 30],
  ]);
  assert(map.get(new Uint8Array()) === 10, "empty key value");
  assert(map.get(byteKey(2, 3, 4)) === 30, "known key value");
  assert(map.get(byteKey(99)) === undefined, "unknown key value");
});

Deno.test("archived byte MPHF rejects duplicates and returns allocations", () => {
  let duplicateThrew = false;
  try {
    new StaticMphfBytesBuilder().add(byteKey(1, 2)).add(byteKey(1, 2));
  } catch (error) {
    duplicateThrew = error instanceof RangeError;
  }
  assert(duplicateThrew, "duplicate keys must be rejected");

  const before = StaticMphfBytes.allocatorStats();
  {
    const builder = new StaticMphfBytesBuilder();
    for (let index = 0; index < 2_000; index++) builder.add(fixed16(index));
    using mphf = builder.freeze();
    assert(mphf.length === 2_000, "all keys must be stored");
  }
  const after = StaticMphfBytes.allocatorStats();
  assert(after.liveAllocations === before.liveAllocations, "live allocations must return");
  assert(after.liveBytes === before.liveBytes, "live bytes must return");
});

Deno.test("archived byte MPHF verifies randomized variable-length misses", () => {
  const keys: Uint8Array[] = [];
  let state = 0x6d2b_79f5;
  for (let input = 0; input < 5_000; input++) {
    const key = new Uint8Array(5 + (input % 59));
    new DataView(key.buffer).setUint32(0, input, true);
    for (let index = 4; index < key.length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      key[index] = state >>> 24;
    }
    keys.push(key);
  }

  using mphf = StaticMphfBytes.from(keys);
  const slots = new Set<number>();
  for (let input = 0; input < keys.length; input++) {
    const key = keys[input]!;
    slots.add(mphf.lookup(key));
    const miss = key.slice();
    miss[0] ^= 0x80;
    assert(mphf.lookup(miss) === -1, `exact miss input=${input}`);
  }
  assert(slots.size === keys.length, "known keys must map to unique slots");
});
