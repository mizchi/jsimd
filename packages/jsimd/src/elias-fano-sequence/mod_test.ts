import {
  EliasFanoSequence,
  EliasFanoSequenceBuilder,
  PartitionedEliasFanoSequence,
  PartitionedEliasFanoSequenceBuilder,
} from "../elias-fano-sequence/mod.ts";
import { assertEquals } from "../../test/assert.ts";

Deno.test("EliasFanoSequence preserves monotone values and duplicates", () => {
  using sequence = EliasFanoSequence.from([1, 1, 2, 4, 4, 4, 100]);
  assertEquals(sequence.length, 7, "Elias-Fano length");
  assertEquals(sequence.toUint32Array().join(","), "1,1,2,4,4,4,100", "Elias-Fano decode");
  assertEquals(sequence.at(0), 1, "first value");
  assertEquals(sequence.at(6), 100, "last value");
  assertEquals(sequence.rank(0), 0, "rank below minimum");
  assertEquals(sequence.rank(1), 0, "strict rank");
  assertEquals(sequence.rank(4), 3, "rank before duplicates");
  assertEquals(sequence.rank(101), 7, "rank above maximum");
  assertEquals(sequence.nextGEQ(3), 4, "nextGEQ");
  assertEquals(sequence.nextGEQ(101), -1, "missing nextGEQ");
  assertEquals(sequence.predecessor(4), 2, "strict predecessor");
  assertEquals(sequence.predecessor(1), -1, "missing predecessor");
});

Deno.test("EliasFanoSequence supports dense and complete Uint32 domains", () => {
  using dense = EliasFanoSequence.from([0, 0, 1, 1, 2, 3, 4]);
  assertEquals(dense.lowerBits, 0, "dense lower-bit width");
  assertEquals(dense.toUint32Array().join(","), "0,0,1,1,2,3,4", "dense values");

  using sparse = EliasFanoSequence.from([0, 0x8000_0000, 0xffff_ffff]);
  assertEquals(sparse.at(2), 0xffff_ffff, "Uint32 maximum");
  assertEquals(sparse.rank(0xffff_ffff), 2, "rank Uint32 maximum");
  assertEquals(sparse.rank(0x1_0000_0000), 3, "rank full Uint32 bound");
  assertEquals(sparse.nextGEQ(0x8000_0001), 0xffff_ffff, "sparse successor");

  using singleton = EliasFanoSequence.from([0xffff_ffff]);
  assertEquals(singleton.lowerBits, 32, "full-width lower part");
  assertEquals(singleton.at(0), 0xffff_ffff, "full-width lower value");
});

Deno.test("EliasFanoSequence builder freezes independent snapshots", () => {
  const builder = new EliasFanoSequenceBuilder();
  builder.append(1).append(1).append(10);
  using first = builder.freeze();
  builder.append(100);
  using second = builder.freeze();
  assertEquals(first.toUint32Array().join(","), "1,1,10", "first snapshot");
  assertEquals(second.toUint32Array().join(","), "1,1,10,100", "second snapshot");

  let threw = false;
  try {
    builder.append(99);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true, "descending append");
});

Deno.test("EliasFanoSequence batches independent point and rank queries", () => {
  using sequence = EliasFanoSequence.from([1, 3, 3, 9, 100, 1000]);
  const values = new Uint32Array(3);
  sequence.atMany(new Uint32Array([5, 0, 3]), values);
  assertEquals(values.join(","), "1000,1,9", "Elias-Fano atMany");

  const ranks = new Uint32Array(4);
  sequence.rankMany(new Uint32Array([0, 3, 4, 0xffff_ffff]), ranks);
  assertEquals(ranks.join(","), "0,1,3,6", "Elias-Fano rankMany");
});

Deno.test("EliasFanoSequence matches scalar randomized monotone sequences", () => {
  let state = 0x1319_8a2e;
  for (const length of [0, 1, 31, 32, 127, 128, 129, 4097]) {
    const values = new Uint32Array(length);
    let value = 0;
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      value += state & 7;
      values[index] = value;
    }
    using sequence = EliasFanoSequence.fromUint32Array(values);
    assertEquals(sequence.toUint32Array().join(","), values.join(","), `EF decode ${length}`);
    for (let query = 0; query < 100; query++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const target = length === 0 ? state : state % (value + 10);
      let expectedRank = 0;
      while (expectedRank < values.length && values[expectedRank]! < target) expectedRank++;
      assertEquals(sequence.rank(target), expectedRank, `EF rank ${length}/${query}`);
      assertEquals(
        sequence.nextGEQ(target),
        expectedRank === length ? -1 : values[expectedRank],
        `EF next ${length}/${query}`,
      );
    }
  }
});

Deno.test("EliasFanoSequence using lifecycle reaches an allocator plateau", () => {
  const values = Uint32Array.from({ length: 10_000 }, (_, index) => index * 17);
  for (let iteration = 0; iteration < 10; iteration++) {
    using sequence = EliasFanoSequence.fromUint32Array(values);
    sequence.rank(iteration);
  }
  const plateau = EliasFanoSequence.allocatorStats();
  for (let iteration = 0; iteration < 10; iteration++) {
    using sequence = EliasFanoSequence.fromUint32Array(values);
    sequence.at(iteration);
  }
  const after = EliasFanoSequence.allocatorStats();
  assertEquals(after.liveAllocations, plateau.liveAllocations, "EF live allocations");
  assertEquals(after.liveBytes, plateau.liveBytes, "EF live bytes");
  assertEquals(after.reservedBytes, plateau.reservedBytes, "EF reserved bytes");
});

Deno.test("PartitionedEliasFanoSequence adapts contiguous and local EF blocks", () => {
  const values = Uint32Array.from([
    100,
    101,
    102,
    103,
    1_000_000,
    1_000_003,
    1_000_010,
    1_000_100,
    4_000_000_000,
    4_000_000_000,
    4_000_000_001,
  ]);
  using sequence = PartitionedEliasFanoSequence.fromUint32Array(values, 4);
  assertEquals(sequence.length, values.length, "length");
  assertEquals(sequence.blockSize, 4, "block size");
  assertEquals(sequence.blockCount, 3, "block count");
  assertEquals(sequence.encodingCounts().contiguous, 1, "contiguous blocks");
  assertEquals(sequence.encodingCounts().eliasFano, 2, "EF blocks");
  assertEquals(sequence.toUint32Array().join(","), values.join(","), "decode");
  for (let index = 0; index < values.length; index++) {
    assertEquals(sequence.at(index), values[index], `at ${index}`);
  }
});

Deno.test("PartitionedEliasFanoSequence preserves ordered queries across duplicate boundaries", () => {
  const builder = new PartitionedEliasFanoSequenceBuilder(3);
  for (const value of [1, 2, 2, 2, 2, 7, 100, 101, 102]) builder.append(value);
  using sequence = builder.freeze();
  for (const query of [0, 1, 2, 3, 7, 8, 102, 103, 2 ** 32]) {
    const values = [1, 2, 2, 2, 2, 7, 100, 101, 102];
    const expected = values.findIndex((value) => value >= query);
    const rank = expected === -1 ? values.length : expected;
    assertEquals(sequence.rank(query), rank, `rank ${query}`);
    assertEquals(
      sequence.nextGEQ(query),
      rank === values.length ? -1 : values[rank],
      `next ${query}`,
    );
    assertEquals(sequence.predecessor(query), rank === 0 ? -1 : values[rank - 1], `prev ${query}`);
  }
});

Deno.test("PartitionedEliasFanoSequence using lifecycle releases child encodings", () => {
  const before = EliasFanoSequence.allocatorStats();
  {
    using sequence = PartitionedEliasFanoSequence.fromUint32Array(
      Uint32Array.from({ length: 1000 }, (_, index) => index * index),
      128,
    );
    assertEquals(sequence.at(999), 998001, "live sequence");
  }
  const after = EliasFanoSequence.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
