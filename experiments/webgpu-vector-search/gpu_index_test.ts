import { WebGpuVectorSearch } from "./gpu_index.ts";

Deno.test("WebGPU resident squared-L2 top-k matches a stable scalar reference", async () => {
  const adapter = await getAdapter();
  if (!adapter) return;

  const rows = 513;
  const dimensions = 7;
  const values = makeValues(rows, dimensions);
  const query = values.slice(137 * dimensions, 138 * dimensions);
  const expected = scalarTopK(values, rows, dimensions, query, 10);

  await using search = await WebGpuVectorSearch.create({ adapter, maxK: 16 });
  using index = search.upload(values, rows, dimensions);
  const actual = await index.topK(query, 10);

  assertEquals([...actual.ids], [...expected.ids]);
  for (let rank = 0; rank < expected.distances.length; rank++) {
    const error = Math.abs(actual.distances[rank]! - expected.distances[rank]!);
    if (error > 1e-4) throw new Error(`distance ${rank} differs by ${error}`);
  }
});

Deno.test("WebGPU profile separates dispatch synchronization from result readback", async () => {
  const adapter = await getAdapter();
  if (!adapter) return;

  const rows = 300;
  const dimensions = 16;
  const values = makeValues(rows, dimensions);
  const query = values.slice(0, dimensions);

  await using search = await WebGpuVectorSearch.create({ adapter, maxK: 4 });
  using index = search.upload(values, rows, dimensions);
  const result = await index.profileTopK(query, 4);

  assertEquals(result.ids[0], 0);
  assertEquals(result.distances[0], 0);
  if (result.dispatchMs < 0 || result.readbackMs < 0 || result.totalMs < 0) {
    throw new Error("profile timings must be non-negative");
  }
  if (result.totalMs < result.dispatchMs || result.totalMs < result.readbackMs) {
    throw new Error("total time must cover both profiled phases");
  }
});

Deno.test("WebGPU batches independent top-k queries into one readback", async () => {
  const adapter = await getAdapter();
  if (!adapter) return;

  const rows = 513;
  const dimensions = 7;
  const values = makeValues(rows, dimensions);
  const queries = new Float32Array(dimensions * 2);
  queries.set(values.subarray(0, dimensions), 0);
  queries.set(values.subarray(137 * dimensions, 138 * dimensions), dimensions);

  await using search = await WebGpuVectorSearch.create({ adapter, maxK: 4, maxBatchSize: 2 });
  using index = search.upload(values, rows, dimensions);
  const actual = await index.topKBatch(queries, 2, 4);

  const first = scalarTopK(values, rows, dimensions, queries.subarray(0, dimensions), 4);
  const second = scalarTopK(values, rows, dimensions, queries.subarray(dimensions), 4);
  assertEquals([...actual.ids], [...first.ids, ...second.ids]);
});

Deno.test("WebGPU vector search validates shape, k, and disposal", async () => {
  const adapter = await getAdapter();
  if (!adapter) return;

  await using search = await WebGpuVectorSearch.create({ adapter, maxK: 4 });
  using index = search.upload(new Float32Array(32), 4, 8);

  await assertRejects(() => index.topK(new Float32Array(7), 1), RangeError);
  await assertRejects(() => index.topK(new Float32Array(8), 5), RangeError);
  index[Symbol.dispose]();
  await assertRejects(() => index.topK(new Float32Array(8), 1), Error);
});

function makeValues(rows: number, dimensions: number): Float32Array {
  const values = new Float32Array(rows * dimensions);
  let random = 0x1234_5678;
  for (let index = 0; index < values.length; index++) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    values[index] = (random >>> 8) / 0x80_0000 - 1;
  }
  return values;
}

function scalarTopK(
  values: Float32Array,
  rows: number,
  dimensions: number,
  query: Float32Array,
  k: number,
): { ids: Uint32Array; distances: Float32Array } {
  const pairs = Array.from({ length: rows }, (_, id) => {
    let distance = 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      const delta = values[id * dimensions + dimension]! - query[dimension]!;
      distance += delta * delta;
    }
    return { id, distance };
  });
  pairs.sort((left, right) => left.distance - right.distance || left.id - right.id);
  return {
    ids: Uint32Array.from(pairs.slice(0, k), (pair) => pair.id),
    distances: Float32Array.from(pairs.slice(0, k), (pair) => pair.distance),
  };
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof expected) return;
    throw error;
  }
  throw new Error(`expected ${expected.name}`);
}

async function getAdapter(): Promise<GPUAdapter | null> {
  return "gpu" in navigator ? await navigator.gpu.requestAdapter() : null;
}
