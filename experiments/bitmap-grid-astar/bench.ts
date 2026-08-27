import { BitmapGridAStar } from "./prototype/mod.ts";

const WARMUPS = 10;
const SAMPLES = 30;
const WIDTHS = [128, 256, 512] as const;

class JsGridAStar {
  readonly #width: number;
  readonly #height: number;
  readonly #cellCount: number;
  readonly #blockedBytes?: Uint8Array;
  readonly #blockedWords?: Uint32Array;
  readonly #distances: Uint32Array;
  readonly #previous: Uint32Array;
  readonly #heap: JsHeap;

  constructor(
    width: number,
    height: number,
    blocked: Uint8Array | Uint32Array,
    arity: 2 | 4,
  ) {
    this.#width = width;
    this.#height = height;
    this.#cellCount = width * height;
    if (blocked instanceof Uint8Array) this.#blockedBytes = blocked;
    else this.#blockedWords = blocked;
    this.#distances = new Uint32Array(this.#cellCount);
    this.#previous = new Uint32Array(this.#cellCount);
    this.#heap = new JsHeap(this.#cellCount * 4 + 1, arity);
  }

  findPath(start: number, target: number): { distance: number; path: Uint32Array } {
    this.#distances.fill(0xffff_ffff);
    this.#previous.fill(0xffff_ffff);
    this.#heap.clear();
    this.#distances[start] = 0;
    this.#heap.push(start, priority(0, start, target, this.#width, this.#width + this.#height));
    while (this.#heap.pop()) {
      const node = this.#heap.poppedId;
      const distance = this.#distances[node]!;
      if (distance === 0xffff_ffff) continue;
      const expected = priority(
        distance,
        node,
        target,
        this.#width,
        this.#width + this.#height,
      );
      if (this.#heap.poppedPriority !== expected) continue;
      if (node === target) break;
      const x = node % this.#width;
      if (x > 0) this.#relax(node - 1, node, distance, target);
      if (x + 1 < this.#width) this.#relax(node + 1, node, distance, target);
      if (node >= this.#width) this.#relax(node - this.#width, node, distance, target);
      if (node + this.#width < this.#cellCount) {
        this.#relax(node + this.#width, node, distance, target);
      }
    }
    const distance = this.#distances[target]!;
    if (distance === 0xffff_ffff) return { distance: Infinity, path: new Uint32Array() };
    const reversed: number[] = [];
    for (let node = target;; node = this.#previous[node]!) {
      reversed.push(node);
      if (node === start) break;
    }
    reversed.reverse();
    return { distance, path: Uint32Array.from(reversed) };
  }

  #relax(neighbor: number, node: number, distance: number, target: number): void {
    if (this.#isBlocked(neighbor)) return;
    const next = distance + 1;
    if (next >= this.#distances[neighbor]!) return;
    this.#distances[neighbor] = next;
    this.#previous[neighbor] = node;
    this.#heap.push(
      neighbor,
      priority(next, neighbor, target, this.#width, this.#width + this.#height),
    );
  }

  #isBlocked(node: number): boolean {
    return this.#blockedBytes !== undefined
      ? this.#blockedBytes[node] !== 0
      : (this.#blockedWords![node >>> 5]! & 1 << (node & 31)) !== 0;
  }
}

class JsHeap {
  readonly #ids: Uint32Array;
  readonly #priorities: Uint32Array;
  readonly #arity: 2 | 4;
  #size = 0;
  poppedId = 0;
  poppedPriority = 0;

  constructor(capacity: number, arity: 2 | 4) {
    this.#ids = new Uint32Array(capacity);
    this.#priorities = new Uint32Array(capacity);
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

function benchmark(width: number, kind: "open" | "barriers") {
  const blocked = kind === "open" ? new Uint8Array(width * width) : alternatingBarriers(width);
  const words = pack(blocked);
  const start = kind === "open" ? 0 : Math.floor(width / 2) * width;
  const target = kind === "open" ? width * width - 1 : Math.floor(width / 2) * width + width - 1;
  const jsByteBinary = new JsGridAStar(width, width, blocked, 2);
  const jsByteFour = new JsGridAStar(width, width, blocked, 4);
  const jsBitmapFour = new JsGridAStar(width, width, words, 4);
  using wasm = BitmapGridAStar.fromBitmap(width, width, words);

  const byteBinaryMs = measure(() => jsByteBinary.findPath(start, target));
  const byteFourMs = measure(() => jsByteFour.findPath(start, target));
  const bitmapFourMs = measure(() => jsBitmapFour.findPath(start, target));
  const wasmScalarMs = measure(() =>
    wasm.findPathScalar(
      start % width,
      Math.floor(start / width),
      target % width,
      Math.floor(target / width),
    )
  );
  const wasmSimdMs = measure(() =>
    wasm.findPathSimd(
      start % width,
      Math.floor(start / width),
      target % width,
      Math.floor(target / width),
    )
  );
  const expected = jsByteBinary.findPath(start, target);
  const actual = wasm.findPath(
    start % width,
    Math.floor(start / width),
    target % width,
    Math.floor(target / width),
  );
  if (expected.distance !== actual.distance) throw new Error(`${kind} ${width} mismatch`);
  const bestJs = Math.min(byteBinaryMs, byteFourMs, bitmapFourMs);
  return {
    map: `${kind}-${width}x${width}`,
    cells: width * width,
    pathLength: actual.path.length,
    obstacleBytes: blocked.byteLength,
    bitmapBytes: words.byteLength,
    wasmResidentBytes: wasm.residentBytes,
    jsByteBinaryMedianMs: round(byteBinaryMs),
    jsByteFourAryMedianMs: round(byteFourMs),
    jsBitmapFourAryMedianMs: round(bitmapFourMs),
    wasmScalarBitmapMedianMs: round(wasmScalarMs),
    wasmSimdBitmapMedianMs: round(wasmSimdMs),
    simdVsScalarWasm: round(wasmScalarMs / wasmSimdMs),
    simdVsBestJs: round(bestJs / wasmSimdMs),
  };
}

function alternatingBarriers(width: number): Uint8Array {
  const blocked = new Uint8Array(width * width);
  let barrier = 0;
  for (let x = 8; x < width - 1; x += 8, barrier++) {
    const gapStart = barrier % 2 === 0 ? width - 5 : 1;
    for (let y = 0; y < width; y++) {
      if (y < gapStart || y >= gapStart + 4) blocked[y * width + x] = 1;
    }
  }
  return blocked;
}

function pack(blocked: Uint8Array): Uint32Array {
  const words = new Uint32Array(Math.ceil(blocked.length / 32));
  for (let index = 0; index < blocked.length; index++) {
    if (blocked[index] !== 0) words[index >>> 5] |= 1 << (index & 31);
  }
  return words;
}

function priority(
  distance: number,
  node: number,
  target: number,
  width: number,
  tieScale: number,
): number {
  const x = node % width;
  const y = Math.floor(node / width);
  const targetX = target % width;
  const targetY = Math.floor(target / width);
  const heuristic = Math.abs(x - targetX) + Math.abs(y - targetY);
  return (distance + heuristic) * tieScale + heuristic;
}

function less(
  leftPriority: number,
  _leftId: number,
  rightPriority: number,
  _rightId: number,
): boolean {
  return leftPriority < rightPriority;
}

function measure(run: () => unknown): number {
  const samples: number[] = [];
  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const started = performance.now();
    run();
    const elapsed = performance.now() - started;
    if (sample >= 0) samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const results = WIDTHS.flatMap((width) => [benchmark(width, "open"), benchmark(width, "barriers")]);
console.log(JSON.stringify(
  {
    runtime: { ...Deno.version, ...Deno.build },
    warmups: WARMUPS,
    samples: SAMPLES,
    results,
  },
  null,
  2,
));
