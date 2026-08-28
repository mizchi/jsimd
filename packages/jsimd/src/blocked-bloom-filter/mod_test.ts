import { BlockedBloomFilterU32 } from "../blocked-bloom-filter/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("BlockedBloomFilterU32 has no false negatives and merges compatible blocks", () => {
  const leftKeys = Uint32Array.from({ length: 2_048 }, (_, index) => index * 17);
  const rightKeys = Uint32Array.from({ length: 2_048 }, (_, index) => index * 17 + 1);
  using left = BlockedBloomFilterU32.from(leftKeys, 12);
  using right = BlockedBloomFilterU32.from(rightKeys, 12);
  const output = new Uint8Array(leftKeys.length + 1).fill(0xff);
  assertEquals(left.mayContainMany(leftKeys, output), leftKeys.length, "left hit count");
  assertEquals(
    output.subarray(0, leftKeys.length).every((value) => value === 1),
    true,
    "left has no false negatives",
  );
  assertEquals(output.at(-1), 0xff, "bulk output tail");
  left.merge(right);
  assertEquals(left.mayContainMany(rightKeys, output), rightKeys.length, "merged hit count");
  left.clear();
  assertEquals(left.mayContainMany(leftKeys, output), 0, "cleared filter");
});

Deno.test("BlockedBloomFilterU32 bounds false positives and releases using-owned blocks", () => {
  const before = BlockedBloomFilterU32.allocatorStats();
  {
    const keys = Uint32Array.from({ length: 8_192 }, (_, index) => Math.imul(index, 17) >>> 0);
    const misses = Uint32Array.from(
      { length: 65_536 },
      (_, index) => (0x8000_0000 + Math.imul(index, 31)) >>> 0,
    );
    using filter = BlockedBloomFilterU32.from(keys, 12);
    const output = new Uint8Array(misses.length);
    const falsePositives = filter.mayContainMany(misses, output);
    assertEquals(falsePositives < misses.length * 0.05, true, "false-positive bound");
  }
  const after = BlockedBloomFilterU32.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "Bloom live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "Bloom live bytes");
});

Deno.test("BlockedBloomFilterU32 rejects incompatible and invalid operations", () => {
  using small = new BlockedBloomFilterU32(16, 8);
  using large = new BlockedBloomFilterU32(1_024, 8);

  let mergeThrew = false;
  try {
    small.merge(large);
  } catch (error) {
    mergeThrew = error instanceof RangeError;
  }
  assertEquals(mergeThrew, true, "incompatible merge");

  let outputThrew = false;
  try {
    small.mayContainMany(Uint32Array.of(1, 2), new Uint8Array(1));
  } catch (error) {
    outputThrew = error instanceof RangeError;
  }
  assertEquals(outputThrew, true, "undersized output");

  const disposed = new BlockedBloomFilterU32(16);
  disposed[Symbol.dispose]();
  let disposedThrew = false;
  try {
    disposed.addMany(Uint32Array.of(1));
  } catch (error) {
    disposedThrew = error instanceof Error;
  }
  assertEquals(disposedThrew, true, "use after dispose");

  let allocationThrew = false;
  try {
    new BlockedBloomFilterU32(0x0400_0001, 128);
  } catch (error) {
    allocationThrew = error instanceof RangeError;
  }
  assertEquals(allocationThrew, true, "Wasm allocation bound");
});
