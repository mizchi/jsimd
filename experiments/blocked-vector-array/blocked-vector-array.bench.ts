import { afterAll, bench, describe } from "vitest";
import { BlockedVectorArray } from "../../packages/jsimd/src/blocked-vector-array/mod.ts";
import { PdxFloat32Index } from "../../packages/jsimd/src/binary-vector-index/mod.ts";

const LENGTH = 16_384;
const DIMENSIONS = 64;
const values = Float32Array.from(
  { length: LENGTH * DIMENSIONS },
  (_, index) => ((Math.imul(index + 1, 2_654_435_761) >>> 8) & 0xffff) / 32_768 - 1,
);
const query = values.slice(0, DIMENSIONS);
const output = new Float32Array(LENGTH);
const TOP_K = 10;
const topIds = new Uint32Array(TOP_K);
const topDistances = new Float32Array(TOP_K);
const sortIds = Array.from({ length: LENGTH }, (_, index) => index);
const heapIds = new Uint32Array(TOP_K);
const heapDistances = new Float32Array(TOP_K);
const top100Ids = new Uint32Array(100);
const top100Distances = new Float32Array(100);
const heap100Ids = new Uint32Array(100);
const heap100Distances = new Float32Array(100);
const topProductIds = new Uint32Array(TOP_K);
const topProducts = new Float32Array(TOP_K);
const heapProductIds = new Uint32Array(TOP_K);
const heapProducts = new Float32Array(TOP_K);
let sink = 0;

function scalarSquaredL2(): void {
  for (let row = 0; row < LENGTH; row++) {
    let sum = 0;
    const offset = row * DIMENSIONS;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      const delta = values[offset + dimension]! - query[dimension]!;
      sum += delta * delta;
    }
    output[row] = sum;
  }
}

function scalarL1(): void {
  for (let row = 0; row < LENGTH; row++) {
    let sum = 0;
    const offset = row * DIMENSIONS;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      sum += Math.abs(values[offset + dimension]! - query[dimension]!);
    }
    output[row] = sum;
  }
}

function scalarInnerProduct(): void {
  for (let row = 0; row < LENGTH; row++) {
    let sum = 0;
    const offset = row * DIMENSIONS;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      sum += values[offset + dimension]! * query[dimension]!;
    }
    output[row] = sum;
  }
}

describe("exact squared L2, 16K x 64", () => {
  const blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
  const pdx4 = PdxFloat32Index.from(values, LENGTH, DIMENSIONS);
  afterAll(() => {
    blocked[Symbol.dispose]();
    pdx4[Symbol.dispose]();
  });

  bench("BlockedVectorArray PDX64", () => {
    blocked.squaredDistanceMany(query, output);
    sink += output[1]!;
  });

  bench("PdxFloat32Index PDX4", () => {
    pdx4.distanceMany(query, output);
    sink += output[1]!;
  });

  bench("Float32Array scalar", () => {
    scalarSquaredL2();
    sink += output[1]!;
  });
});

describe("exact L1 and inner product, 16K x 64", () => {
  const blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
  afterAll(() => blocked[Symbol.dispose]());

  bench("BlockedVectorArray L1 PDX64", () => {
    blocked.l1DistanceMany(query, output);
    sink += output[1]!;
  });

  bench("Float32Array scalar L1", () => {
    scalarL1();
    sink += output[1]!;
  });

  bench("BlockedVectorArray inner product PDX64", () => {
    blocked.innerProductMany(query, output);
    sink += output[1]!;
  });

  bench("Float32Array scalar inner product", () => {
    scalarInnerProduct();
    sink += output[1]!;
  });
});

describe("exact squared L2 top-k, 16K x 64", () => {
  const blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
  afterAll(() => blocked[Symbol.dispose]());

  bench("BlockedVectorArray fused topKInto k=10", () => {
    blocked.topKInto(query, topIds, topDistances);
    sink += topIds[0]!;
  });

  bench("distanceMany + reused JS full sort k=10", () => {
    blocked.squaredDistanceMany(query, output);
    for (let index = 0; index < sortIds.length; index++) sortIds[index] = index;
    sortIds.sort((left, right) => output[left]! - output[right]! || left - right);
    sink += sortIds[0]!;
  });

  bench("distanceMany + bounded JS heap k=10", () => {
    blocked.squaredDistanceMany(query, output);
    selectWithHeap(output, heapIds, heapDistances);
    sink += heapIds[0]!;
  });

  bench("BlockedVectorArray fused topKInto k=100", () => {
    blocked.topKInto(query, top100Ids, top100Distances);
    sink += top100Ids[0]!;
  });

  bench("distanceMany + bounded JS heap k=100", () => {
    blocked.squaredDistanceMany(query, output);
    selectWithHeap(output, heap100Ids, heap100Distances);
    sink += heap100Ids[0]!;
  });
});

describe("exact inner-product top-k, 16K x 64", () => {
  const blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
  afterAll(() => blocked[Symbol.dispose]());

  bench("BlockedVectorArray fused topKInnerProductInto k=10", () => {
    blocked.topKInnerProductInto(query, topProductIds, topProducts);
    sink += topProductIds[0]!;
  });

  bench("innerProductMany + bounded JS heap k=10", () => {
    blocked.innerProductMany(query, output);
    selectLargestWithHeap(output, heapProductIds, heapProducts);
    sink += heapProductIds[0]!;
  });
});

describe("row-major to blocked construction, 16K x 64", () => {
  bench("BlockedVectorArray.from PDX64", () => {
    using blocked = BlockedVectorArray.from(values, LENGTH, DIMENSIONS);
    sink += blocked.get(1, 1);
  });

  bench("PdxFloat32Index.from PDX4", () => {
    using pdx4 = PdxFloat32Index.from(values, LENGTH, DIMENSIONS);
    sink += pdx4.length;
  });

  bench("Float32Array.slice row-major", () => {
    const copy = values.slice();
    sink += copy[DIMENSIONS + 1]!;
  });
});

describe("small repeated exact squared L2, 32 x 64", () => {
  const length = 32;
  const dimensions = 64;
  const smallValues = values.slice(0, length * dimensions);
  const smallQuery = query.slice();
  const smallOutput = new Float32Array(length);
  const blocked = BlockedVectorArray.from(smallValues, length, dimensions);
  afterAll(() => blocked[Symbol.dispose]());

  bench("BlockedVectorArray PDX64", () => {
    blocked.squaredDistanceMany(smallQuery, smallOutput);
    sink += smallOutput[1]!;
  });

  bench("Float32Array scalar", () => {
    for (let row = 0; row < length; row++) {
      let sum = 0;
      const offset = row * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension++) {
        const delta = smallValues[offset + dimension]! - smallQuery[dimension]!;
        sum += delta * delta;
      }
      smallOutput[row] = sum;
    }
    sink += smallOutput[1]!;
  });
});

function selectWithHeap(
  distances: Float32Array,
  ids: Uint32Array,
  selectedDistances: Float32Array,
): void {
  let size = 0;
  for (let id = 0; id < distances.length; id++) {
    const distance = distances[id]!;
    if (size < ids.length) {
      ids[size] = id;
      selectedDistances[size] = distance;
      siftUpMax(ids, selectedDistances, size++);
    } else if (comparePair(distance, id, selectedDistances[0]!, ids[0]!) < 0) {
      ids[0] = id;
      selectedDistances[0] = distance;
      siftDownMax(ids, selectedDistances, 0, size);
    }
  }
  for (let index = 1; index < size; index++) {
    const id = ids[index]!;
    const distance = selectedDistances[index]!;
    let cursor = index;
    while (
      cursor > 0 && comparePair(distance, id, selectedDistances[cursor - 1]!, ids[cursor - 1]!) < 0
    ) {
      ids[cursor] = ids[cursor - 1]!;
      selectedDistances[cursor] = selectedDistances[cursor - 1]!;
      cursor--;
    }
    ids[cursor] = id;
    selectedDistances[cursor] = distance;
  }
}

function selectLargestWithHeap(
  scores: Float32Array,
  ids: Uint32Array,
  selectedScores: Float32Array,
): void {
  let size = 0;
  for (let id = 0; id < scores.length; id++) {
    const score = scores[id]!;
    if (size < ids.length) {
      ids[size] = id;
      selectedScores[size] = score;
      siftUpMin(ids, selectedScores, size++);
    } else if (compareProduct(score, id, selectedScores[0]!, ids[0]!) > 0) {
      ids[0] = id;
      selectedScores[0] = score;
      siftDownMin(ids, selectedScores, 0, size);
    }
  }
  for (let index = 1; index < size; index++) {
    const id = ids[index]!;
    const score = selectedScores[index]!;
    let cursor = index;
    while (
      cursor > 0 && compareProduct(score, id, selectedScores[cursor - 1]!, ids[cursor - 1]!) > 0
    ) {
      ids[cursor] = ids[cursor - 1]!;
      selectedScores[cursor] = selectedScores[cursor - 1]!;
      cursor--;
    }
    ids[cursor] = id;
    selectedScores[cursor] = score;
  }
}

function siftUpMin(ids: Uint32Array, scores: Float32Array, start: number): void {
  let child = start;
  while (child > 0) {
    const parent = (child - 1) >>> 1;
    if (compareProduct(scores[parent]!, ids[parent]!, scores[child]!, ids[child]!) <= 0) return;
    swapPair(ids, scores, parent, child);
    child = parent;
  }
}

function siftDownMin(ids: Uint32Array, scores: Float32Array, start: number, size: number): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= size) return;
    const right = left + 1;
    let child = left;
    if (
      right < size && compareProduct(scores[right]!, ids[right]!, scores[left]!, ids[left]!) < 0
    ) child = right;
    if (compareProduct(scores[parent]!, ids[parent]!, scores[child]!, ids[child]!) <= 0) return;
    swapPair(ids, scores, parent, child);
    parent = child;
  }
}

function compareProduct(
  leftScore: number,
  leftId: number,
  rightScore: number,
  rightId: number,
): number {
  return leftScore - rightScore || rightId - leftId;
}

function siftUpMax(ids: Uint32Array, distances: Float32Array, start: number): void {
  let child = start;
  while (child > 0) {
    const parent = (child - 1) >>> 1;
    if (comparePair(distances[parent]!, ids[parent]!, distances[child]!, ids[child]!) >= 0) return;
    swapPair(ids, distances, parent, child);
    child = parent;
  }
}

function siftDownMax(ids: Uint32Array, distances: Float32Array, start: number, size: number): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= size) return;
    const right = left + 1;
    let child = left;
    if (
      right < size &&
      comparePair(distances[right]!, ids[right]!, distances[left]!, ids[left]!) > 0
    ) child = right;
    if (comparePair(distances[parent]!, ids[parent]!, distances[child]!, ids[child]!) >= 0) return;
    swapPair(ids, distances, parent, child);
    parent = child;
  }
}

function comparePair(
  leftDistance: number,
  leftId: number,
  rightDistance: number,
  rightId: number,
): number {
  return leftDistance - rightDistance || leftId - rightId;
}

function swapPair(ids: Uint32Array, distances: Float32Array, left: number, right: number): void {
  const id = ids[left]!;
  ids[left] = ids[right]!;
  ids[right] = id;
  const distance = distances[left]!;
  distances[left] = distances[right]!;
  distances[right] = distance;
}
