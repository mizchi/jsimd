import {
  BinaryVectorIndex,
  BinaryVectorIndexWithRerank,
  PdxFloat32Index,
} from "../binary-vector-index/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("PdxFloat32Index computes exact squared L2 distances in four-row blocks", () => {
  const count = 7;
  const dimensions = 5;
  const values = Float32Array.from(
    { length: count * dimensions },
    (_, index) => (index % 13) * 0.25 - 1.5,
  );
  const query = Float32Array.from({ length: dimensions }, (_, index) => index * 0.1 - 0.2);
  using index = PdxFloat32Index.from(values, count, dimensions);
  const actual = index.distanceMany(query, new Float32Array(count));
  for (let row = 0; row < count; row++) {
    let expected = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const delta = values[row * dimensions + dimension]! - query[dimension]!;
      expected += delta * delta;
    }
    assertClose(actual[row]!, expected, 1e-5, `row=${row}`);
  }
  const selected = index.distanceSelected(
    query,
    new Uint32Array([6, 0, 3]),
    new Float32Array(3),
  );
  assertClose(selected[0]!, actual[6]!, 1e-5, "selected 6");
  assertClose(selected[1]!, actual[0]!, 1e-5, "selected 0");
  assertClose(selected[2]!, actual[3]!, 1e-5, "selected 3");
});

Deno.test("BinaryVectorIndexWithRerank refines Hamming candidates with exact Float32 L2", () => {
  const values = new Float32Array([
    0.1,
    0.1,
    0.1,
    10,
    10,
    10,
    -0.1,
    -0.1,
    -0.1,
    0.2,
    0.2,
    0.2,
    -10,
    -10,
    -10,
  ]);
  using index = BinaryVectorIndexWithRerank.fromFloat32(values, 5, 3);
  const ids = new Uint32Array(3);
  const distances = new Float32Array(3);
  assertEquals(index.topK(new Float32Array([0, 0, 0]), 3, 5, ids, distances), 3, "count");
  assertEquals(ids.join(","), "0,2,3", "exact order");
  assertClose(distances[0]!, 0.03, 1e-5, "first distance");
  assertClose(distances[1]!, 0.03, 1e-5, "second distance");
  assertClose(distances[2]!, 0.12, 1e-5, "third distance");
});

Deno.test("PDX and rerank using lifecycle release all resident storage", () => {
  const before = BinaryVectorIndex.allocatorStats();
  {
    const values = Float32Array.from({ length: 1024 * 17 }, (_, index) => index % 19);
    using index = BinaryVectorIndexWithRerank.fromFloat32(values, 1024, 17);
    const ids = new Uint32Array(10);
    const distances = new Float32Array(10);
    index.topK(new Float32Array(17), 10, 100, ids, distances);
  }
  const after = BinaryVectorIndex.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});

Deno.test("BinaryVectorIndex computes exact Hamming distances and top-k", () => {
  using index = BinaryVectorIndex.fromSignatures([
    new Uint8Array([0x00, 0x00]),
    new Uint8Array([0xff, 0x00]),
    new Uint8Array([0xff, 0xff]),
    new Uint8Array([0x0f, 0x0f]),
  ]);
  const distances = new Uint32Array(index.length);
  index.distanceMany(new Uint8Array([0x00, 0x00]), distances);
  assertEquals(distances.join(","), "0,8,16,8", "distances");
  const ids = new Uint32Array(3);
  const topDistances = new Uint32Array(3);
  assertEquals(index.topK(new Uint8Array([0, 0]), 3, ids, topDistances), 3, "top count");
  assertEquals(topDistances.join(","), "0,8,8", "top distances");
  assertEquals(ids[0], 0, "nearest ID");
});

Deno.test("BinaryVectorIndex quantizes Float32 signs", () => {
  using index = BinaryVectorIndex.fromFloat32(
    new Float32Array([1, -1, 0, 2, -3, 4, 5, -6, -1, -1, 1, 1, 1, 1, -1, -1]),
    2,
    8,
  );
  assertEquals(index.dimensions, 8, "dimensions");
  const distances = new Uint32Array(2);
  index.distanceMany(new Uint8Array([0b0110_1001]), distances);
  assertEquals(distances.join(","), "0,4", "quantized distances");
});

Deno.test("BinaryVectorIndex preserves non-byte-aligned Float32 dimensions", () => {
  using index = BinaryVectorIndex.fromFloat32(
    new Float32Array([
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
    ]),
    2,
    10,
  );
  assertEquals(index.dimensions, 10, "logical dimensions");
  const distances = new Uint32Array(2);
  // Bits 10..15 are padding and must not contribute to the logical distance.
  index.distanceMany(new Uint8Array([0xff, 0xff]), distances);
  assertEquals(distances.join(","), "0,10", "padding bits ignored");
});

Deno.test("BinaryVectorIndex matches scalar distances across SIMD tails", () => {
  for (const bytes of [1, 15, 16, 17, 31, 32, 33]) {
    const signatures = Array.from(
      { length: 129 },
      (_, row) =>
        Uint8Array.from({ length: bytes }, (_, column) => Math.imul(row + 1, column + 17) & 0xff),
    );
    const query = Uint8Array.from({ length: bytes }, (_, index) => Math.imul(index, 31) & 0xff);
    using index = BinaryVectorIndex.fromSignatures(signatures);
    const actual = new Uint32Array(signatures.length);
    index.distanceMany(query, actual);
    for (let row = 0; row < signatures.length; row++) {
      let expected = 0;
      for (let byte = 0; byte < bytes; byte++) {
        expected += ((signatures[row]![byte]! ^ query[byte]!) >>> 0).toString(2).split("1").length -
          1;
      }
      assertEquals(actual[row], expected, `bytes=${bytes}, row=${row}`);
    }
  }
});

Deno.test("BinaryVectorIndex using lifecycle returns storage", () => {
  const signatures = Array.from({ length: 256 }, () => new Uint8Array(32));
  const before = BinaryVectorIndex.allocatorStats();
  for (let iteration = 0; iteration < 1000; iteration++) {
    using index = BinaryVectorIndex.fromSignatures(signatures);
    const output = new Uint32Array(index.length);
    index.distanceMany(signatures[0]!, output);
  }
  const after = BinaryVectorIndex.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "live allocations");
  assertEquals(after.liveBytes, before.liveBytes, "live bytes");
});
