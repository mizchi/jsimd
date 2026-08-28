import { FmIndexBytes } from "../fm-index-bytes/mod.ts";
import { assertEquals } from "../../test/assert.ts";

function scalarByteCount(text: Uint8Array, pattern: Uint8Array): number {
  if (pattern.length === 0) return text.length + 1;
  let count = 0;
  outer:
  for (let start = 0; start + pattern.length <= text.length; start++) {
    for (let index = 0; index < pattern.length; index++) {
      if (text[start + index] !== pattern[index]) continue outer;
    }
    count++;
  }
  return count;
}

function scalarBytePositions(text: Uint8Array, pattern: Uint8Array): number[] {
  if (pattern.length === 0) return Array.from({ length: text.length + 1 }, (_, index) => index);
  const positions: number[] = [];
  outer:
  for (let start = 0; start + pattern.length <= text.length; start++) {
    for (let index = 0; index < pattern.length; index++) {
      if (text[start + index] !== pattern[index]) continue outer;
    }
    positions.push(start);
  }
  return positions;
}

Deno.test("FmIndexBytes counts overlapping arbitrary-byte patterns", () => {
  const encoder = new TextEncoder();
  using index = FmIndexBytes.from(encoder.encode("banana"));
  assertEquals(index.length, 6, "text length");
  assertEquals(index.count(encoder.encode("ana")), 2, "overlapping ana");
  assertEquals(index.count(encoder.encode("na")), 2, "na");
  assertEquals(index.count(encoder.encode("banana")), 1, "whole text");
  assertEquals(index.count(encoder.encode("x")), 0, "missing");
  assertEquals(index.count(new Uint8Array()), 7, "empty pattern suffixes");
});

Deno.test("FmIndexBytes countMany amortizes the Wasm boundary", () => {
  const text = Uint8Array.of(0, 255, 0, 1, 0, 255, 0);
  using index = FmIndexBytes.from(text);
  const patterns = Uint8Array.of(0, 255, 0, 0, 1, 2);
  const offsets = Uint32Array.of(0, 0, 1, 3, 5, 6);
  const output = index.countMany(patterns, offsets);
  assertEquals(output.join(","), "8,4,2,1,0", "batch counts");
});

Deno.test("FmIndexBytes locates sampled suffix-array positions", () => {
  const encoder = new TextEncoder();
  using index = FmIndexBytes.from(encoder.encode("banana"));
  assertEquals(Array.from(index.locate(encoder.encode("ana"))).sort().join(","), "1,3", "ana");
  assertEquals(Array.from(index.locate(encoder.encode("na"))).sort().join(","), "2,4", "na");
  assertEquals(index.locate(encoder.encode("x")).length, 0, "missing");
  const patterns = encoder.encode("ananaX");
  const located = index.locateMany(patterns, Uint32Array.of(0, 3, 5, 6));
  assertEquals(located.offsets.join(","), "0,2,4,4", "result offsets");
  assertEquals(
    Array.from(located.positions.subarray(0, 2)).sort().join(","),
    "1,3",
    "first positions",
  );
  assertEquals(
    Array.from(located.positions.subarray(2, 4)).sort().join(","),
    "2,4",
    "second positions",
  );
});

Deno.test("FmIndexBytes matches scalar randomized pattern counts", () => {
  let state = 0x1020_3040;
  const text = Uint8Array.from({ length: 2_048 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state & 15;
  });
  using index = FmIndexBytes.from(text);
  for (let query = 0; query < 250; query++) {
    const length = query % 9;
    const pattern = new Uint8Array(length);
    for (let byte = 0; byte < length; byte++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      pattern[byte] = state & 15;
    }
    const expectedCount = scalarByteCount(text, pattern);
    assertEquals(index.count(pattern), expectedCount, `query=${query}`);
    if (query < 32) {
      assertEquals(
        Array.from(index.locate(pattern)).sort((left, right) => left - right).join(","),
        scalarBytePositions(text, pattern).join(","),
        `locate query=${query}`,
      );
    }
  }
});

Deno.test("FmIndexBytes using lifecycle returns allocator storage", () => {
  const before = FmIndexBytes.allocatorStats();
  {
    using index = FmIndexBytes.from(new Uint8Array(10_000));
    assertEquals(index.count(Uint8Array.of(0, 0)), 9_999, "resident count");
  }
  const after = FmIndexBytes.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
