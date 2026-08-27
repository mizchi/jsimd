import { MultithreadVectorSearch } from "./search.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("MultithreadVectorSearch matches stable scalar squared-L2 top-k", async () => {
  const count = 257;
  const dimensions = 17;
  const k = 9;
  const values = deterministicVectors(count, dimensions);
  await using search = await MultithreadVectorSearch.create(values, count, dimensions, {
    workerCount: 3,
    k,
  });

  for (const seed of [11, 29, 71]) {
    const query = deterministicQuery(dimensions, seed);
    const actual = await search.search(query);
    const expected = scalarTopK(values, count, dimensions, query, k);
    assert(actual.ids.length === k && actual.distances.length === k, "top-k shape");
    for (let index = 0; index < k; index++) {
      assert(actual.ids[index] === expected.ids[index], `id ${index}`);
      assert(
        Math.abs(actual.distances[index]! - expected.distances[index]!) < 1e-4,
        `distance ${index}`,
      );
    }
  }
});

Deno.test("MultithreadVectorSearch merges short shards and equal-distance ties", async () => {
  const values = new Float32Array([
    1,
    0,
    -1,
    0,
    0,
    1,
    0,
    -1,
    2,
    0,
  ]);
  await using search = await MultithreadVectorSearch.create(values, 5, 2, {
    workerCount: 4,
    k: 5,
  });
  const result = await search.search(new Float32Array([0, 0]));
  assert(
    result.ids.every((id, index) => id === [0, 1, 2, 3, 4][index]),
    "ties use global row ID",
  );
  assert(
    result.distances.every((distance, index) => distance === [1, 1, 1, 1, 4][index]),
    "short shard distances",
  );
});

function deterministicVectors(count: number, dimensions: number): Float32Array {
  const output = new Float32Array(count * dimensions);
  let state = 0x1234_5678;
  for (let index = 0; index < output.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = ((state >>> 8) / 0x100_0000) * 2 - 1;
  }
  return output;
}

function deterministicQuery(dimensions: number, seed: number): Float32Array {
  const output = new Float32Array(dimensions);
  let state = seed;
  for (let index = 0; index < dimensions; index++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    output[index] = ((state >>> 8) / 0x100_0000) * 2 - 1;
  }
  return output;
}

function scalarTopK(
  values: Float32Array,
  count: number,
  dimensions: number,
  query: Float32Array,
  k: number,
): { ids: Uint32Array; distances: Float32Array } {
  const distances = new Float32Array(count);
  for (let row = 0; row < count; row++) {
    let distance = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const delta = values[row * dimensions + dimension]! - query[dimension]!;
      distance += delta * delta;
    }
    distances[row] = distance;
  }
  const order = Uint32Array.from({ length: count }, (_, index) => index);
  order.sort((left, right) => distances[left]! - distances[right]! || left - right);
  const ids = order.slice(0, k);
  return {
    ids,
    distances: Float32Array.from(ids, (id) => distances[id]!),
  };
}
