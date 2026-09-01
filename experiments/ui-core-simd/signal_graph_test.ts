import { PackedSignalGraph } from "./signal_graph.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function join(values: ArrayLike<number>): string {
  return Array.from(values).join(",");
}

Deno.test("PackedSignalGraph unions subscriber rows and fires each effect once", async () => {
  const graph = await PackedSignalGraph.create({
    effectCount: 6,
    subscribersBySignal: [[0, 2, 4], [1, 2], [2, 3, 5]],
  });

  assertEquals(join(graph.collect([0, 1, 0], "scalar")), "0,1,2,4", "scalar union");
  assertEquals(join(graph.collect([0, 1, 0], "simd")), "0,1,2,4", "SIMD union");
  assertEquals(
    join(graph.collectPacked(Uint32Array.of(0, 1), "simd")),
    "0,1,2,4",
    "packed SIMD union",
  );
  assertEquals(graph.lastStrategy, "scalar", "sparse rows fall back to scalar");

  assertEquals(graph.strategyFor([0, 1]), "scalar", "small graph planner");
});

Deno.test("PackedSignalGraph planner reserves SIMD for dense fan-out batches", async () => {
  const denseRows = Array.from(
    { length: 8 },
    (_, signalId) => Array.from({ length: 128 }, (_, index) => (signalId * 113 + index) % 1_024),
  );
  const sparseRows = Array.from({ length: 8 }, (_, signalId) => [signalId]);
  const dense = await PackedSignalGraph.create({
    effectCount: 1_024,
    subscribersBySignal: denseRows,
  });
  const sparse = await PackedSignalGraph.create({
    effectCount: 1_024,
    subscribersBySignal: sparseRows,
  });
  assertEquals(dense.strategyFor([0, 1]), "simd", "dense planner");
  assertEquals(sparse.strategyFor([0, 1]), "scalar", "sparse planner");

  const compactDense = await PackedSignalGraph.create({
    effectCount: 128,
    subscribersBySignal: [[0, 1, 2, 3], [4, 5, 6, 7]],
  });
  assertEquals(compactDense.strategyFor([0, 1]), "simd", "compact dense planner");
});

Deno.test("PackedSignalGraph allocates dense rows only for high fan-out signals", async () => {
  const graph = await PackedSignalGraph.create({
    effectCount: 128,
    subscribersBySignal: [
      [0, 1, 2, 3],
      [4, 5, 6],
      [7, 8, 9, 10, 11],
      [],
    ],
  });
  assertEquals(graph.strategyFor([0, 2]), "simd", "all dense rows use SIMD");
  assertEquals(graph.strategyFor([0, 1]), "scalar", "mixed rows use scalar");
  assertEquals(join(graph.collect([0, 2], "simd")), "0,1,2,3,7,8,9,10,11", "dense union");
  assertEquals(join(graph.collect([0, 1], "simd")), "0,1,2,3,4,5,6", "mixed fallback");
  assertEquals(graph.lastStrategy, "scalar", "forced SIMD falls back for sparse rows");

  const reusable = await PackedSignalGraph.create({
    effectCount: 128,
    subscribersBySignal: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]],
  });
  const firstView = reusable.collectPacked(Uint32Array.of(0, 1), "simd");
  const secondView = reusable.collectPacked(Uint32Array.of(1, 2), "simd");
  assertEquals(firstView.buffer === secondView.buffer, true, "SIMD results reuse graph storage");
  assertEquals(firstView === secondView, true, "equal-sized SIMD results reuse the same view");
});

Deno.test("PackedSignalGraph SIMD and scalar collection agree on randomized graphs", async () => {
  let state = 0x1234_5678;
  const random = () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
  for (const effectCount of [0, 1, 31, 32, 127, 128, 129, 1025]) {
    const signalCount = 19;
    const rows = Array.from({ length: signalCount }, () => {
      const subscribers: number[] = [];
      for (let effectId = 0; effectId < effectCount; effectId++) {
        if ((random() & 15) === 0) subscribers.push(effectId);
      }
      return subscribers;
    });
    const graph = await PackedSignalGraph.create({ effectCount, subscribersBySignal: rows });
    for (let iteration = 0; iteration < 20; iteration++) {
      const changed = Array.from({ length: 1 + (random() % 12) }, () => random() % signalCount);
      assertEquals(
        join(graph.collect(changed, "simd")),
        join(graph.collect(changed, "scalar")),
        `effectCount=${effectCount}, iteration=${iteration}`,
      );
    }
  }
});

Deno.test("PackedSignalGraph validates graph and dispatch inputs", async () => {
  await assertRejects(
    () => PackedSignalGraph.create({ effectCount: 2, subscribersBySignal: [[2]] }),
    RangeError,
  );
  const graph = await PackedSignalGraph.create({ effectCount: 2, subscribersBySignal: [[0]] });
  assertThrows(() => graph.collect([1]), RangeError);
  assertThrows(() => graph.collect([0], "invalid" as "simd"), TypeError);
});

Deno.test("PackedSignalGraph falls back to scalar when Wasm is unavailable", async () => {
  const graph = await PackedSignalGraph.create({
    effectCount: 4,
    subscribersBySignal: [[0, 2], [1, 2, 3]],
    wasm: false,
  });
  assertEquals(join(graph.collect([0, 1], "simd")), "0,1,2,3", "fallback result");
  assertEquals(graph.lastStrategy, "scalar", "fallback strategy");
});

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}
