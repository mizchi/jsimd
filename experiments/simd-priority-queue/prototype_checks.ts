import { DijkstraCsrGraph, SimdPriorityQueueU32 } from "./prototype/mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("SimdPriorityQueueU32 orders priorities and stable IDs", () => {
  using queue = new SimdPriorityQueueU32(2);
  queue.push(9, 4).push(7, 1).push(3, 1).push(5, 2);
  assert(queue.size === 4, "size after pushes");
  assert(queue.capacity >= 4, "automatic growth");

  const actual = [];
  while (queue.size > 0) actual.push(queue.pop());
  assert(
    JSON.stringify(actual) === JSON.stringify([
      { id: 3, priority: 1 },
      { id: 7, priority: 1 },
      { id: 5, priority: 2 },
      { id: 9, priority: 4 },
    ]),
    "priority then ID order",
  );
  assert(queue.pop() === undefined, "empty pop");
});

Deno.test("SimdPriorityQueueU32 batches insertion and reuses pop outputs", () => {
  using queue = new SimdPriorityQueueU32();
  queue.pushMany(
    new Uint32Array([10, 20, 30, 40]),
    new Float32Array([8, 2, 6, 4]),
  );
  const id = new Uint32Array(1);
  const priority = new Float32Array(1);
  const actual: number[] = [];
  while (queue.popInto(id, priority)) actual.push(id[0]!);
  assert(actual.join(",") === "20,40,30,10", "batched heap order");
});

Deno.test("SimdPriorityQueueU32 matches a randomized stable sort", () => {
  const count = 2_057;
  const ids = new Uint32Array(count);
  const priorities = new Float32Array(count);
  let state = 0x1234_5678;
  for (let index = 0; index < count; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    ids[index] = state;
    priorities[index] = state % 97;
  }
  const expected = Array.from(ids, (id, index) => ({ id, priority: priorities[index]! }));
  expected.sort((left, right) => left.priority - right.priority || left.id - right.id);

  using queue = new SimdPriorityQueueU32(count);
  queue.pushMany(ids, priorities);
  for (const entry of expected) {
    const actual = queue.pop();
    assert(actual?.id === entry.id && actual.priority === entry.priority, "randomized order");
  }
});

Deno.test("DijkstraCsrGraph SIMD and scalar kernels reconstruct the same path", () => {
  const offsets = new Uint32Array([0, 2, 4, 6, 7, 8, 8]);
  const targets = new Uint32Array([1, 2, 2, 3, 3, 4, 5, 5]);
  const weights = new Float32Array([2, 8, 2, 5, 1, 8, 3, 1]);
  using graph = DijkstraCsrGraph.from(offsets, targets, weights);

  const simd = graph.shortestPath(0, 5);
  const scalar = graph.shortestPathScalar(0, 5);
  assert(simd.distance === 8, "shortest distance");
  assert(simd.path.join(",") === "0,1,2,3,5", "shortest path");
  assert(JSON.stringify(simd) === JSON.stringify(scalar), "SIMD and scalar match");
});

Deno.test("DijkstraCsrGraph reports unreachable targets and validates weights", () => {
  using graph = DijkstraCsrGraph.from(
    new Uint32Array([0, 1, 1, 1]),
    new Uint32Array([1]),
    new Float32Array([1]),
  );
  const result = graph.shortestPath(0, 2);
  assert(result.distance === Infinity, "unreachable distance");
  assert(result.path.length === 0, "unreachable path");

  let rejected = false;
  try {
    DijkstraCsrGraph.from(
      new Uint32Array([0, 1]),
      new Uint32Array([0]),
      new Float32Array([-1]),
    );
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assert(rejected, "negative edge rejected");
});

Deno.test("experimental queue and graph return allocator storage with using", () => {
  const before = SimdPriorityQueueU32.allocatorStats();
  runAllocationPhase();
  const plateau = SimdPriorityQueueU32.allocatorStats();
  runAllocationPhase();
  const after = SimdPriorityQueueU32.allocatorStats();
  assert(after.liveAllocations === before.liveAllocations, "live allocations return to baseline");
  assert(after.liveBytes === before.liveBytes, "live bytes return to baseline");
  assert(after.reservedBytes === plateau.reservedBytes, "allocator reaches a reuse plateau");

  const queue = new SimdPriorityQueueU32();
  queue[Symbol.dispose]();
  let rejected = false;
  try {
    queue.push(1, 1);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("disposed");
  }
  assert(rejected, "use after dispose rejected");
});

function runAllocationPhase(): void {
  for (let iteration = 0; iteration < 8; iteration++) {
    using queue = new SimdPriorityQueueU32(1);
    for (let value = 0; value < 257; value++) queue.push(value, 257 - value);
    using graph = DijkstraCsrGraph.from(
      new Uint32Array([0, 1, 2, 2]),
      new Uint32Array([1, 2]),
      new Float32Array([1, 1]),
    );
    graph.shortestPath(0, 2);
  }
}
