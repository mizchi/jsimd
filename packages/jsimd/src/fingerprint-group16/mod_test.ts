import { FingerprintGroup16, FingerprintTable16 } from "../fingerprint-group16/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("FingerprintGroup16 returns SwissTable control masks", () => {
  using group = FingerprintGroup16.from(
    Uint8Array.of(7, 1, 7, 0x80, 0xfe, 7, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
  );
  assertEquals(group.matchMask(7), 0b0000_0100_0010_0101, "fingerprint mask");
  assertEquals(group.emptyMask(), 1 << 3, "empty mask");
  assertEquals(group.deletedMask(), 1 << 4, "deleted mask");
  assertEquals(group.availableMask(), (1 << 3) | (1 << 4), "available mask");
  assertEquals(group.firstMatch(7), 0, "first match");
  assertEquals(group.firstMatch(127), -1, "missing match");
});

Deno.test("FingerprintGroup16 batches probes into reusable Uint16 output", () => {
  using group = FingerprintGroup16.from(
    Uint8Array.from({ length: 16 }, (_, index) => index & 3),
  );
  const output = new Uint16Array(6);
  group.matchMany(Uint8Array.of(0, 1, 2, 3, 4, 127), output);
  assertEquals(output.join(","), "4369,8738,17476,34952,0,0", "batch masks");
});

Deno.test("FingerprintGroup16 validates controls and releases using-owned storage", () => {
  const before = FingerprintGroup16.allocatorStats();
  for (let iteration = 0; iteration < 1_000; iteration++) {
    using group = FingerprintGroup16.empty();
    assertEquals(group.emptyMask(), 0xffff, "all empty");
  }
  const after = FingerprintGroup16.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("FingerprintTable16 stores and probes multiple aligned groups", () => {
  using table = new FingerprintTable16(64);
  table.setControl(1, 7).setControl(18, 7).setControl(19, 3).setControl(33, 7);
  assertEquals(table.matchMask(0, 7), 1 << 1, "group zero");
  assertEquals(table.matchMask(1, 7), 1 << 2, "group one");
  assertEquals(table.matchMask(2, 7), 1 << 1, "group two");
  assertEquals(table.emptyMask(1), 0xffff ^ ((1 << 2) | (1 << 3)), "group empties");
  table.delete(18);
  assertEquals(table.deletedMask(1), 1 << 2, "deleted lane");
});

Deno.test("FingerprintTable16 batches primary group and fingerprint masks", () => {
  using table = new FingerprintTable16(64);
  table.setControl(1, 7).setControl(18, 7).setControl(19, 3).setControl(33, 7);
  const hashes = Uint32Array.of((7 << 25) | 1, (7 << 25) | 18, (3 << 25) | 19, (9 << 25) | 33);
  const groups = new Uint32Array(hashes.length);
  const matches = new Uint16Array(hashes.length);
  const empty = new Uint16Array(hashes.length);
  const deleted = new Uint16Array(hashes.length);
  table.probeMany(hashes, groups, matches, empty, deleted);
  assertEquals(groups.join(","), "0,16,16,32", "group offsets");
  assertEquals(matches.join(","), "2,4,8,0", "candidate masks");
  assertEquals(deleted.join(","), "0,0,0,0", "deleted masks");
  assertEquals(empty[0], 0xfffd, "empty group zero");
});
