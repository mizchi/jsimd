import { DijkstraCsrGraph, SimdPriorityQueueU32 } from "./prototype/mod.ts";

const WARMUPS = 3;
const SAMPLES = 20;
const QUEUE_ITEMS = 65_536;
const GRID_WIDTHS = [64, 128, 256] as const;

function benchmarkQueues() {
  const ids = new Uint32Array(QUEUE_ITEMS);
  const priorities = new Float32Array(QUEUE_ITEMS);
  for (let index = 0; index < QUEUE_ITEMS; index++) {
    const mixed = Math.imul(index + 1, 2_654_435_761) >>> 0;
    ids[index] = mixed;
    priorities[index] = (mixed >>> 8) / 0x100_0000;
  }
  const js = new JsFourAryHeap(QUEUE_ITEMS);
  using simdPoint = new SimdPriorityQueueU32(QUEUE_ITEMS);
  using simdBatch = new SimdPriorityQueueU32(QUEUE_ITEMS);
  let sink = 0;
  const pointId = new Uint32Array(1);
  const pointPriority = new Float32Array(1);
  const batchId = new Uint32Array(1);
  const batchPriority = new Float32Array(1);

  const jsMs = measure(() => {
    js.clear();
    for (let index = 0; index < QUEUE_ITEMS; index++) js.push(ids[index]!, priorities[index]!);
    while (js.pop()) sink ^= js.poppedId;
  });
  const simdPointMs = measure(() => {
    simdPoint.clear();
    for (let index = 0; index < QUEUE_ITEMS; index++) {
      simdPoint.push(ids[index]!, priorities[index]!);
    }
    while (simdPoint.popInto(pointId, pointPriority)) sink ^= pointId[0]!;
  });
  const simdBatchMs = measure(() => {
    simdBatch.clear().pushMany(ids, priorities);
    while (simdBatch.popInto(batchId, batchPriority)) sink ^= batchId[0]!;
  });
  if (sink === 0x1_0000_0000) throw new Error("unreachable sink");
  return {
    items: QUEUE_ITEMS,
    jsFourAryMedianMs: round(jsMs),
    simdPointMedianMs: round(simdPointMs),
    simdBatchPushMedianMs: round(simdBatchMs),
    pointSpeedup: round(jsMs / simdPointMs),
    batchPushSpeedup: round(jsMs / simdBatchMs),
  };
}

function benchmarkGrid(width: number) {
  const { offsets, targets, weights } = weightedGrid(width);
  const start = 0;
  const target = width * width - 1;
  const jsBinary = new JsDijkstraGraph(offsets, targets, weights, 2);
  const jsFourAry = new JsDijkstraGraph(offsets, targets, weights, 4);
  using wasm = DijkstraCsrGraph.from(offsets, targets, weights);

  const jsBinaryMs = measure(() => jsBinary.shortestPath(start, target).distance);
  const jsFourAryMs = measure(() => jsFourAry.shortestPath(start, target).distance);
  const wasmScalarMs = measure(() => wasm.shortestPathScalar(start, target).distance);
  const wasmSimdMs = measure(() => wasm.shortestPath(start, target).distance);
  const expected = jsBinary.shortestPath(start, target);
  const actual = wasm.shortestPath(start, target);
  if (Math.abs(expected.distance - actual.distance) > 1e-3) {
    throw new Error(`distance mismatch for ${width}x${width}`);
  }
  return {
    grid: `${width}x${width}`,
    nodes: width * width,
    edges: targets.length,
    pathLength: actual.path.length,
    jsBinaryMedianMs: round(jsBinaryMs),
    jsFourAryMedianMs: round(jsFourAryMs),
    wasmScalarFourAryMedianMs: round(wasmScalarMs),
    wasmSimdFourAryMedianMs: round(wasmSimdMs),
    simdVsScalarWasm: round(wasmScalarMs / wasmSimdMs),
    simdVsBestJs: round(Math.min(jsBinaryMs, jsFourAryMs) / wasmSimdMs),
  };
}

function weightedGrid(width: number): {
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Float32Array;
} {
  const nodeCount = width * width;
  const offsets = new Uint32Array(nodeCount + 1);
  const targetValues: number[] = [];
  const weightValues: number[] = [];
  for (let node = 0; node < nodeCount; node++) {
    const x = node % width;
    const y = Math.floor(node / width);
    if (x > 0) addEdge(node, node - 1);
    if (x + 1 < width) addEdge(node, node + 1);
    if (y > 0) addEdge(node, node - width);
    if (y + 1 < width) addEdge(node, node + width);
    offsets[node + 1] = targetValues.length;
  }
  return {
    offsets,
    targets: Uint32Array.from(targetValues),
    weights: Float32Array.from(weightValues),
  };

  function addEdge(from: number, to: number): void {
    targetValues.push(to);
    const mixed = Math.imul(from + 1, 1_664_525) ^ Math.imul(to + 1, 1_013_904_223);
    weightValues.push(1 + (mixed >>> 0) % 17 / 16);
  }
}

class JsDijkstraGraph {
  readonly #offsets: Uint32Array;
  readonly #targets: Uint32Array;
  readonly #weights: Float32Array;
  readonly #distances: Float32Array;
  readonly #previous: Uint32Array;
  readonly #heap: JsDijkstraHeap;

  constructor(
    offsets: Uint32Array,
    targets: Uint32Array,
    weights: Float32Array,
    arity: 2 | 4,
  ) {
    this.#offsets = offsets;
    this.#targets = targets;
    this.#weights = weights;
    this.#distances = new Float32Array(offsets.length - 1);
    this.#previous = new Uint32Array(offsets.length - 1);
    this.#heap = new JsDijkstraHeap(targets.length + 1, arity);
  }

  shortestPath(start: number, target: number): { distance: number; path: Uint32Array } {
    this.#distances.fill(Infinity);
    this.#previous.fill(0xffff_ffff);
    this.#heap.clear();
    this.#distances[start] = 0;
    this.#heap.push(start, 0);
    while (this.#heap.pop()) {
      const node = this.#heap.poppedId;
      const distance = this.#heap.poppedPriority;
      if (distance !== this.#distances[node]) continue;
      if (node === target) break;
      for (let edge = this.#offsets[node]!; edge < this.#offsets[node + 1]!; edge++) {
        const neighbor = this.#targets[edge]!;
        const nextDistance = Math.fround(distance + this.#weights[edge]!);
        if (nextDistance < this.#distances[neighbor]!) {
          this.#distances[neighbor] = nextDistance;
          this.#previous[neighbor] = node;
          this.#heap.push(neighbor, nextDistance);
        }
      }
    }
    const distance = this.#distances[target]!;
    if (distance === Infinity) return { distance, path: new Uint32Array() };
    const reversed: number[] = [];
    for (let node = target;; node = this.#previous[node]!) {
      reversed.push(node);
      if (node === start) break;
    }
    reversed.reverse();
    return { distance, path: Uint32Array.from(reversed) };
  }
}

class JsDijkstraHeap {
  readonly #ids: Uint32Array;
  readonly #priorities: Float32Array;
  readonly #arity: 2 | 4;
  #size = 0;
  poppedId = 0;
  poppedPriority = 0;

  constructor(capacity: number, arity: 2 | 4) {
    this.#ids = new Uint32Array(capacity);
    this.#priorities = new Float32Array(capacity);
    this.#arity = arity;
  }

  clear(): void {
    this.#size = 0;
  }

  push(id: number, priority: number): void {
    let cursor = this.#size++;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / this.#arity);
      if (!less(priority, id, this.#priorities[parent]!, this.#ids[parent]!)) break;
      this.#priorities[cursor] = this.#priorities[parent]!;
      this.#ids[cursor] = this.#ids[parent]!;
      cursor = parent;
    }
    this.#priorities[cursor] = priority;
    this.#ids[cursor] = id;
  }

  pop(): boolean {
    if (this.#size === 0) return false;
    this.poppedId = this.#ids[0]!;
    this.poppedPriority = this.#priorities[0]!;
    const nextSize = --this.#size;
    if (nextSize === 0) return true;
    const movingId = this.#ids[nextSize]!;
    const movingPriority = this.#priorities[nextSize]!;
    let cursor = 0;
    while (true) {
      const first = cursor * this.#arity + 1;
      if (first >= nextSize) break;
      const end = Math.min(first + this.#arity, nextSize);
      let child = first;
      for (let candidate = first + 1; candidate < end; candidate++) {
        if (
          less(
            this.#priorities[candidate]!,
            this.#ids[candidate]!,
            this.#priorities[child]!,
            this.#ids[child]!,
          )
        ) child = candidate;
      }
      if (!less(this.#priorities[child]!, this.#ids[child]!, movingPriority, movingId)) break;
      this.#priorities[cursor] = this.#priorities[child]!;
      this.#ids[cursor] = this.#ids[child]!;
      cursor = child;
    }
    this.#priorities[cursor] = movingPriority;
    this.#ids[cursor] = movingId;
    return true;
  }
}

class JsFourAryHeap extends JsDijkstraHeap {
  constructor(capacity: number) {
    super(capacity, 4);
  }
}

function less(
  leftPriority: number,
  leftId: number,
  rightPriority: number,
  rightId: number,
): boolean {
  return leftPriority < rightPriority || leftPriority === rightPriority && leftId < rightId;
}

function measure(run: () => unknown): number {
  const samples: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    if (sample >= 0) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const queueResult = benchmarkQueues();
const dijkstraResults = GRID_WIDTHS.map(benchmarkGrid);
console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build },
    warmups: WARMUPS,
    samples: SAMPLES,
    queue: queueResult,
    dijkstra: dijkstraResults,
  },
  null,
  2,
));
