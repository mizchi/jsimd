import { RankSelectBitVector, RankSelectBitVectorBuilder } from "../rank-select-bit-vector/mod.ts";
import { assertEquals, rangeBy } from "../../test/assert.ts";

Deno.test("RankSelectBitVector defines rank and select boundary semantics", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  assertEquals(bits.length, 20, "length");
  assertEquals(bits.countOnes, 7, "count ones");
  assertEquals(bits.get(0), true, "get set bit");
  assertEquals(bits.get(2), false, "get clear bit");
  assertEquals(bits.rank1(0), 0, "rank1 empty prefix");
  assertEquals(bits.rank1(1), 1, "rank1 includes bit before end");
  assertEquals(bits.rank1(8), 4, "rank1 excludes end");
  assertEquals(bits.rank1(20), 7, "rank1 full length");
  assertEquals(bits.rank0(8), 4, "rank0");
  assertEquals(bits.select1(0), 0, "first one");
  assertEquals(bits.select1(4), 8, "fifth one");
  assertEquals(bits.select1(6), 19, "last one");
  assertEquals(bits.select1(7), -1, "missing rank");
  assertEquals(bits.select1(-1), -1, "negative rank");
});

Deno.test("RankSelectBitVector is the canonical frozen rank/select API", () => {
  const builder = new RankSelectBitVectorBuilder(96);
  builder.insert(1).insert(32).insert(95);
  using bits = builder.freeze();
  assertEquals(bits instanceof RankSelectBitVector, true, "canonical runtime type");
  assertEquals(bits.rank1(33), 2, "rank");
  assertEquals(bits.select1(2), 95, "select");
});

Deno.test("RankSelectBitVector finds neighboring bits inclusively", () => {
  using bits = RankSelectBitVector.from(20, [0, 4, 9, 19]);
  assertEquals(bits.next1(0), 0, "next exact");
  assertEquals(bits.next1(1), 4, "next after gap");
  assertEquals(bits.next1(19), 19, "next last");
  assertEquals(bits.next1(20), -1, "next at end");
  assertEquals(bits.prev1(19), 19, "previous exact");
  assertEquals(bits.prev1(18), 9, "previous before gap");
  assertEquals(bits.prev1(0), 0, "previous first");
  assertEquals(bits.prev1(-1), -1, "previous before start");
});

Deno.test("RankSelectBitVector crosses 128-bit and 512-bit blocks", () => {
  const positions = [0, 31, 32, 127, 128, 510, 511, 512, 513, 1023, 1024, 1030];
  using bits = RankSelectBitVector.from(1031, positions);
  for (let index = 0; index < positions.length; index++) {
    assertEquals(bits.rank1(positions[index]!), index, `rank before ${positions[index]}`);
    assertEquals(bits.select1(index), positions[index], `select ${index}`);
  }
  assertEquals(bits.rank1(1031), positions.length, "rank tail");
});

Deno.test("RankSelectBitVectorBuilder freezes an immutable snapshot", () => {
  const builder = new RankSelectBitVectorBuilder(600);
  builder.insert(1).insert(511).insert(512).insert(599).remove(1);
  using frozen = builder.freeze();
  builder.insert(1).remove(512);
  assertEquals(frozen.get(1), false, "snapshot excludes removed bit");
  assertEquals(frozen.get(512), true, "snapshot retains later mutation");
  assertEquals(frozen.toArray().join(","), "511,512,599", "frozen values");
});

Deno.test("RankSelectBitVector executes rank and select queries in bulk", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  const before = RankSelectBitVector.allocatorStats();
  const rankOutput = new Uint32Array(6);
  assertEquals(
    bits.rank1Many(new Uint32Array([0, 1, 8, 9, 20, 20]), rankOutput),
    rankOutput,
    "rank output reuse",
  );
  assertEquals(rankOutput.join(","), "0,1,4,5,7,7", "bulk ranks");
  const selectOutput = new Int32Array(5);
  assertEquals(
    bits.select1Many(new Uint32Array([0, 4, 6, 7, 100]), selectOutput),
    selectOutput,
    "select output reuse",
  );
  assertEquals(selectOutput.join(","), "0,8,19,-1,-1", "bulk selects");
  const after = RankSelectBitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "bulk scratch allocations");
  assertEquals(after.liveBytes, before.liveBytes, "bulk scratch bytes");
});

Deno.test("RankSelectBitVector exposes symmetric zero-bit queries", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  assertEquals(bits.select0(0), 2, "first zero");
  assertEquals(bits.select0(4), 9, "fifth zero");
  assertEquals(bits.select0(12), 18, "last zero");
  assertEquals(bits.select0(13), -1, "missing zero");
  assertEquals(bits.select0(-1), -1, "negative zero rank");
  assertEquals(bits.next0(-10), 2, "next zero before start");
  assertEquals(bits.next0(2), 2, "next zero exact");
  assertEquals(bits.next0(3), 4, "next zero after set bit");
  assertEquals(bits.next0(19), -1, "next zero after last zero");
  assertEquals(bits.prev0(100), 18, "previous zero after end");
  assertEquals(bits.prev0(18), 18, "previous zero exact");
  assertEquals(bits.prev0(3), 2, "previous zero before set bit");
  assertEquals(bits.prev0(1), -1, "previous zero before first zero");
});

Deno.test("RankSelectBitVector bulk zero queries reuse outputs", () => {
  using bits = RankSelectBitVector.from(20, [0, 1, 3, 7, 8, 15, 19]);
  const before = RankSelectBitVector.allocatorStats();
  const rankOutput = new Uint32Array(6);
  assertEquals(
    bits.rank0Many(new Uint32Array([0, 1, 8, 9, 20, 20]), rankOutput),
    rankOutput,
    "rank0 output reuse",
  );
  assertEquals(rankOutput.join(","), "0,0,4,4,13,13", "bulk zero ranks");
  const selectOutput = new Int32Array(5);
  assertEquals(
    bits.select0Many(new Uint32Array([0, 4, 12, 13, 100]), selectOutput),
    selectOutput,
    "select0 output reuse",
  );
  assertEquals(selectOutput.join(","), "2,9,18,-1,-1", "bulk zero selects");
  const after = RankSelectBitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "zero bulk scratch allocations");
  assertEquals(after.liveBytes, before.liveBytes, "zero bulk scratch bytes");
});

Deno.test("RankSelectBitVector never exposes padded zero bits", () => {
  for (const length of [0, 1, 31, 32, 33, 127, 128, 129, 511, 512, 513]) {
    using bits = RankSelectBitVector.from(length, rangeBy(0, length, 1));
    assertEquals(bits.rank0(length), 0, `rank0 full length=${length}`);
    assertEquals(bits.select0(0), -1, `select0 padding length=${length}`);
    assertEquals(bits.next0(0), -1, `next0 padding length=${length}`);
    assertEquals(bits.prev0(length), -1, `prev0 padding length=${length}`);
    const output = new Int32Array(2);
    bits.select0Many(new Uint32Array([0, 0xffff_ffff]), output);
    assertEquals(output.join(","), "-1,-1", `select0Many padding length=${length}`);
  }
});

Deno.test("RankSelectBitVector matches scalar randomized references", () => {
  let state = 0x6d2b_79f5;
  for (const length of [0, 1, 127, 128, 511, 512, 513, 4099]) {
    const expected: number[] = [];
    for (let position = 0; position < length; position++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      if ((state & 7) === 0) expected.push(position);
    }
    using bits = RankSelectBitVector.from(length, expected);
    let rank = 0;
    for (let end = 0; end <= length; end++) {
      assertEquals(bits.rank1(end), rank, `rank length=${length} end=${end}`);
      if (end < length && expected[rank] === end) rank++;
    }
    for (let index = 0; index < expected.length; index++) {
      assertEquals(bits.select1(index), expected[index], `select length=${length} rank=${index}`);
    }
    const zeros = rangeBy(0, length, 1).filter((position) => !bits.get(position));
    for (let index = 0; index < zeros.length; index++) {
      assertEquals(bits.select0(index), zeros[index], `select0 length=${length} rank=${index}`);
    }
    const ends = Uint32Array.from(rangeBy(0, length + 1, Math.max(1, Math.ceil(length / 31))));
    const rank0Output = bits.rank0Many(ends);
    for (let index = 0; index < ends.length; index++) {
      assertEquals(
        rank0Output[index],
        ends[index]! - bits.rank1(ends[index]!),
        `rank0Many length=${length} query=${index}`,
      );
    }
    const zeroRanks = Uint32Array.from([...zeros.keys(), zeros.length, 0xffff_ffff]);
    const select0Output = bits.select0Many(zeroRanks);
    for (let index = 0; index < zeroRanks.length; index++) {
      assertEquals(
        select0Output[index],
        zeros[index] ?? -1,
        `select0Many length=${length} query=${index}`,
      );
    }
  }
});

Deno.test("RankSelectBitVector using lifecycle returns allocator storage", () => {
  const before = RankSelectBitVector.allocatorStats();
  {
    using bits = RankSelectBitVector.from(1_000_000, [1, 10, 999_999]);
    assertEquals(bits.rank1(1_000_000), 3, "live rank");
  }
  const after = RankSelectBitVector.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
