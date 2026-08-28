import { BlockedVectorArray } from "../blocked-vector-array/mod.ts";
import { assertClose, assertEquals } from "../../test/assert.ts";

Deno.test("BlockedVectorArray preserves rows across 64-vector block tails", () => {
  const length = 67;
  const dimensions = 7;
  const values = Float32Array.from(
    { length: length * dimensions },
    (_, index) => ((Math.imul(index + 1, 17) % 101) - 50) / 13,
  );
  using vectors = BlockedVectorArray.from(values, length, dimensions);
  assertEquals(vectors.length, length, "blocked vector length");
  assertEquals(vectors.dimensions, dimensions, "blocked vector dimensions");
  assertEquals(vectors.blockSize, 64, "PDX block size");
  const row = new Float32Array(dimensions);
  for (const index of [0, 63, 64, 66]) {
    vectors.rowInto(index, row);
    for (let dimension = 0; dimension < dimensions; dimension++) {
      assertEquals(
        row[dimension],
        values[index * dimensions + dimension],
        `blocked row ${index}:${dimension}`,
      );
      assertEquals(vectors.get(index, dimension), row[dimension], "blocked get");
    }
  }
});

Deno.test("BlockedVectorArray squared L2 matches row-major scalar results", () => {
  const length = 131;
  const dimensions = 13;
  const values = Float32Array.from(
    { length: length * dimensions },
    (_, index) => ((Math.imul(index + 11, 0x9e37_79b1) >>> 8) & 0xffff) / 32768 - 1,
  );
  const query = values.slice(dimensions * 3, dimensions * 4);
  const output = new Float32Array(length + 1).fill(Number.NaN);
  using vectors = BlockedVectorArray.from(values, length, dimensions);
  vectors.squaredDistanceMany(query, output);
  for (let row = 0; row < length; row++) {
    let expected = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const delta = values[row * dimensions + dimension]! - query[dimension]!;
      expected += delta * delta;
    }
    assertClose(output[row]!, expected, 1e-5, `blocked L2 row ${row}`);
  }
  assertEquals(Number.isNaN(output[length]), true, "blocked L2 output tail");
});

Deno.test("BlockedVectorArray L1 and inner product match row-major scalar results", () => {
  const length = 131;
  const dimensions = 13;
  const values = Float32Array.from(
    { length: length * dimensions },
    (_, index) => ((Math.imul(index + 11, 0x9e37_79b1) >>> 8) & 0xffff) / 32768 - 1,
  );
  const query = values.slice(dimensions * 3, dimensions * 4);
  const l1 = new Float32Array(length);
  const products = new Float32Array(length);
  using vectors = BlockedVectorArray.from(values, length, dimensions);
  vectors.l1DistanceMany(query, l1);
  vectors.innerProductMany(query, products);
  for (let row = 0; row < length; row++) {
    let expectedL1 = 0;
    let expectedProduct = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const value = values[row * dimensions + dimension]!;
      expectedL1 += Math.abs(value - query[dimension]!);
      expectedProduct += value * query[dimension]!;
    }
    assertClose(l1[row]!, expectedL1, 1e-4, `blocked L1 row=${row}`);
    assertClose(products[row]!, expectedProduct, 1e-4, `blocked dot row=${row}`);
  }
});

Deno.test("BlockedVectorArray topKInto fuses selection with deterministic ties", () => {
  using vectors = BlockedVectorArray.from(
    new Float32Array([
      1,
      0,
      -1,
      0,
      0,
      2,
      0,
      -2,
      3,
      0,
    ]),
    5,
    2,
  );
  const ids = new Uint32Array(4);
  const distances = new Float32Array(4);
  assertEquals(vectors.topKInto(new Float32Array([0, 0]), ids, distances), 4, "top-k count");
  assertEquals(ids.join(","), "0,1,2,3", "distance then id ordering");
  assertEquals(distances.join(","), "1,1,4,4", "top-k distances");
});

Deno.test("BlockedVectorArray topKInnerProductInto ranks descending without a JS sort", () => {
  using vectors = BlockedVectorArray.from(
    new Float32Array([1, 0, -1, 0, 2, 0, -2, 0]),
    4,
    2,
  );
  const ids = new Uint32Array(3);
  const products = new Float32Array(3);
  assertEquals(
    vectors.topKInnerProductInto(new Float32Array([1, 0]), ids, products),
    3,
    "inner-product top-k count",
  );
  assertEquals(ids.join(","), "2,0,1", "descending product then id ordering");
  assertEquals(products.join(","), "2,1,-1", "top inner products");
});

Deno.test("BlockedVectorArray topKInto matches scalar sorting across block tails", () => {
  const length = 131;
  const dimensions = 13;
  const values = Float32Array.from(
    { length: length * dimensions },
    (_, index) => ((Math.imul(index + 11, 0x9e37_79b1) >>> 8) & 0xffff) / 32768 - 1,
  );
  const query = values.slice(dimensions * 3, dimensions * 4);
  using vectors = BlockedVectorArray.from(values, length, dimensions);
  for (const k of [0, 1, 7, 64, length]) {
    const ids = new Uint32Array(k);
    const distances = new Float32Array(k);
    assertEquals(vectors.topKInto(query, ids, distances), k, `count k=${k}`);
    const expected = Array.from({ length }, (_, id) => {
      let distance = 0;
      for (let dimension = 0; dimension < dimensions; dimension++) {
        const delta = values[id * dimensions + dimension]! - query[dimension]!;
        distance += delta * delta;
      }
      return { id, distance: Math.fround(distance) };
    }).sort((left, right) => left.distance - right.distance || left.id - right.id);
    for (let index = 0; index < k; index++) {
      assertEquals(ids[index], expected[index]!.id, `id k=${k}/${index}`);
      assertClose(distances[index]!, expected[index]!.distance, 1e-5, `distance k=${k}/${index}`);
    }
  }
});

Deno.test("BlockedVectorArray inner-product top-k matches scalar sorting across block tails", () => {
  const length = 131;
  const dimensions = 13;
  const values = Float32Array.from(
    { length: length * dimensions },
    (_, index) => ((Math.imul(index + 11, 0x9e37_79b1) >>> 8) & 0xffff) / 32768 - 1,
  );
  const query = values.slice(dimensions * 3, dimensions * 4);
  using vectors = BlockedVectorArray.from(values, length, dimensions);
  const expected = Array.from({ length }, (_, id) => {
    let product = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      product += values[id * dimensions + dimension]! * query[dimension]!;
    }
    return { id, product };
  }).sort((left, right) => right.product - left.product || left.id - right.id);
  for (const k of [0, 1, 7, 64, length]) {
    const ids = new Uint32Array(k);
    const products = new Float32Array(k);
    assertEquals(vectors.topKInnerProductInto(query, ids, products), k, `count k=${k}`);
    assertEquals(ids.join(","), expected.slice(0, k).map(({ id }) => id).join(","), `ids k=${k}`);
    for (let index = 0; index < k; index++) {
      assertClose(products[index]!, expected[index]!.product, 1e-4, `product k=${k} i=${index}`);
    }
  }
});

Deno.test("BlockedVectorArray validates ownership and releases using-owned storage", () => {
  const before = BlockedVectorArray.allocatorStats();
  {
    using vectors = BlockedVectorArray.from(new Float32Array(65 * 3), 65, 3);
    const output = new Float32Array(vectors.length);
    vectors.squaredDistanceMany(new Float32Array(3), output);
  }
  const after = BlockedVectorArray.allocatorStats();
  assertEquals(after.liveAllocations, before.liveAllocations, "blocked vectors allocations");
  assertEquals(after.liveBytes, before.liveBytes, "blocked vectors bytes");

  let shapeThrew = false;
  try {
    BlockedVectorArray.from(new Float32Array(5), 2, 3);
  } catch (error) {
    shapeThrew = error instanceof RangeError;
  }
  assertEquals(shapeThrew, true, "blocked vector shape");

  using live = BlockedVectorArray.from(new Float32Array(4), 2, 2);
  let topKThrew = false;
  try {
    live.topKInto(new Float32Array(2), new Uint32Array(2), new Float32Array(1));
  } catch (error) {
    topKThrew = error instanceof RangeError;
  }
  assertEquals(topKThrew, true, "blocked vector top-k output shape");
  topKThrew = false;
  try {
    live.topKInto(new Float32Array(2), new Uint32Array(3), new Float32Array(3));
  } catch (error) {
    topKThrew = error instanceof RangeError;
  }
  assertEquals(topKThrew, true, "blocked vector top-k count");

  const disposed = BlockedVectorArray.from(new Float32Array(4), 2, 2);
  disposed[Symbol.dispose]();
  let disposedThrew = false;
  try {
    disposed.get(0, 0);
  } catch (error) {
    disposedThrew = error instanceof Error;
  }
  assertEquals(disposedThrew, true, "blocked vector use after dispose");
});
