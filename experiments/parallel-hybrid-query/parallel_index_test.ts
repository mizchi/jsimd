import { ParallelHybridVectorIndex } from "./parallel_index.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(count: number, dimensions: number) {
  const filters = new Int32Array(count);
  const vectors = new Float32Array(count * dimensions);
  for (let row = 0; row < count; row++) {
    filters[row] = row % 5;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vectors[row * dimensions + dimension] = row + dimension * 0.25;
    }
  }
  return { filters, vectors };
}

Deno.test("persistent Workers merge local top-k over a shared selection mask", async () => {
  const count = 130;
  const dimensions = 5;
  const { filters, vectors } = fixture(count, dimensions);
  await using index = await ParallelHybridVectorIndex.create(filters, vectors, dimensions, {
    workerCount: 2,
    maxK: 8,
  });
  const query = vectors.slice(70 * dimensions, 71 * dimensions);

  const first = await index.searchBetween(query, 2, 3, { k: 3, plan: "filter-first" });
  assert(first.plan === "filter-first", "requested physical plan");
  assert(first.selectedCount === 26, `selected rows: ${first.selectedCount}`);
  assert(first.ids.join(",") === "72,67,77", `top-k: ${first.ids.join(",")}`);
  assert(first.distances[0] === 20, `nearest squared distance: ${first.distances[0]}`);

  const second = await index.searchBetween(query, 0, 5, { k: 2, plan: "filter-first" });
  assert(second.ids.join(",") === "70,69", "the same persistent pool serves another generation");
  assert(index.queryCount === 2, "queries do not recreate the index");
});

Deno.test("vector-first remains exact while filter-first stays the default", async () => {
  const count = 257;
  const dimensions = 3;
  const { filters, vectors } = fixture(count, dimensions);
  await using index = await ParallelHybridVectorIndex.create(filters, vectors, dimensions, {
    workerCount: 3,
    maxK: 16,
  });
  const query = vectors.slice(200 * dimensions, 201 * dimensions);

  const vectorFirst = await index.searchBetween(query, 2, 3, { k: 4, plan: "vector-first" });
  assert(vectorFirst.ids.join(",") === "202,197,207,192", "vector-first exact top-k");
  assert(vectorFirst.rounds >= 1, "vector-first reports candidate expansion rounds");

  const defaultPlan = await index.searchBetween(query, 0, 5, { k: 2 });
  assert(defaultPlan.plan === "filter-first", "the measured winner remains the default");
  assert(defaultPlan.selector === "wasm", "the measured selector remains the default");
  assert(defaultPlan.ids.join(",") === "200,199", "default result remains exact");
});

Deno.test("parallel hybrid index validates top-k and releases Worker leases", async () => {
  const { filters, vectors } = fixture(65, 4);
  const index = await ParallelHybridVectorIndex.create(filters, vectors, 4, {
    workerCount: 2,
    maxK: 4,
  });
  const query = vectors.slice(0, 4);
  await assertRejects(() => index.searchBetween(query, 0, 5, { k: 5 }));
  await assertRejects(() =>
    index.searchBetweenBinaryRerank(query, 0, 5, { k: 1, candidateMultiplier: 9 })
  );
  await index[Symbol.asyncDispose]();
  assert(index.disposed, "disposed state");
  await assertRejects(() => index.searchBetween(query, 0, 5, { k: 1 }));
});

Deno.test("fused Wasm and JavaScript Worker-local selectors agree", async () => {
  const count = 193;
  const dimensions = 7;
  const { filters, vectors } = fixture(count, dimensions);
  await using index = await ParallelHybridVectorIndex.create(filters, vectors, dimensions, {
    workerCount: 3,
    maxK: 8,
  });
  const query = vectors.slice(111 * dimensions, 112 * dimensions);

  for (const k of [1, 3, 8]) {
    const javascript = await index.searchBetween(query, 1, 4, {
      k,
      selector: "javascript",
    });
    const wasm = await index.searchBetween(query, 1, 4, { k, selector: "wasm" });
    assert(wasm.selector === "wasm", "reported selector");
    assert(wasm.ids.join(",") === javascript.ids.join(","), `k=${k}: ids`);
    assert(wasm.distances.join(",") === javascript.distances.join(","), `k=${k}: distances`);
  }
});

Deno.test("binary shortlist reranks selected candidates by exact PDX distance", async () => {
  const count = 129;
  const dimensions = 16;
  const filters = new Int32Array(count);
  const vectors = new Float32Array(count * dimensions);
  for (let row = 0; row < count; row++) {
    filters[row] = row % 4;
    const code = Math.imul(row + 1, 0x9e37_79b1) >>> 0;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vectors[row * dimensions + dimension] = (code >>> dimension & 1) === 0 ? -1 : 1;
    }
  }
  await using index = await ParallelHybridVectorIndex.create(filters, vectors, dimensions, {
    workerCount: 3,
    maxK: 4,
    maxCandidateMultiplier: 8,
  });
  const query = vectors.slice(77 * dimensions, 78 * dimensions);

  const approximate = await index.searchBetweenBinaryRerank(query, 1, 2, {
    k: 4,
    candidateMultiplier: 4,
  });
  const exact = await index.searchBetween(query, 1, 2, { k: 4 });
  assert(approximate.ids[0] === 77, "exact query row survives the binary shortlist");
  assert(approximate.distances[0] === 0, "candidate is reranked with exact squared L2");
  assert(approximate.selectedCount === 32, "metadata filter cardinality");
  assert(approximate.candidateCount <= 3 * 4 * 4, "only bounded Worker-local candidates rerank");
  assert(approximate.ids.join(",") === exact.ids.join(","), "complete shortlist is exact");
  assert(
    approximate.distances.join(",") === exact.distances.join(","),
    "PDX rerank matches exhaustive squared L2",
  );
});

async function assertRejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("expected rejection");
}
