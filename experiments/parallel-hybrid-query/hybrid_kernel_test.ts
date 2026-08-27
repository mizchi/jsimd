import { SharedBuffer } from "../../src/shared-buffer/mod.ts";
import { instantiateHybridKernels } from "./kernel.ts";
import { SharedSelectionMask } from "./shared_selection_mask.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("shared filter mask feeds PDX top-1 without materialized row IDs", async () => {
  const count = 130;
  const dimensions = 5;
  using owner = await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 2 });
  using consumer = await SharedBuffer.attach(owner.memory);
  const layout = createLayout(count, dimensions);
  const mask = SharedSelectionMask.initialize(owner, layout.maskOffset, count);
  const filterValues = owner.int32Array(layout.filterOffset, count);
  const vectors = float32View(owner, layout.vectorsOffset, layout.paddedCount * dimensions);
  const query = float32View(owner, layout.queryOffset, dimensions);
  for (let row = 0; row < count; row++) {
    filterValues[row] = row;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vectors[pdxOffset(row, dimension, dimensions)] = row + dimension * 0.25;
    }
  }
  for (let dimension = 0; dimension < dimensions; dimension++) {
    query[dimension] = 70 + dimension * 0.25;
  }

  const producerKernels = await instantiateHybridKernels(owner.memory);
  let generation = 0;
  {
    using writer = mask.claimWriter();
    writer.clearAll();
    producerKernels.scan_i32_between_mask(
      absolute(owner, layout.filterOffset),
      count,
      64,
      96,
      absolute(owner, writer.dataByteOffset),
    );
    generation = writer.publish();
  }
  const published = SharedSelectionMask.attach(consumer, layout.maskOffset).read(generation);
  assert(published.countOnes() === 32, "filter cardinality");

  const consumerKernels = await instantiateHybridKernels(consumer.memory);
  consumerKernels.masked_squared_l2_top1_pdx64(
    absolute(consumer, layout.vectorsOffset),
    absolute(consumer, layout.queryOffset),
    count,
    dimensions,
    absolute(consumer, published.dataByteOffset),
    absolute(consumer, layout.scratchOffset),
    absolute(consumer, layout.resultOffset),
  );
  const result = consumer.uint32Array(layout.resultOffset, 3);
  const distance = float32View(consumer, layout.resultOffset + 4, 1)[0]!;
  assert(result[0] === 70, `nearest selected row: ${result[0]}`);
  assert(result[2] === 32, "vector kernel consumed selected count");
  assert(distance === 0, "squared L2 distance");
});

Deno.test("shared hybrid kernel handles empty selections and SIMD tails", async () => {
  const count = 67;
  const dimensions = 3;
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const layout = createLayout(count, dimensions);
  const mask = SharedSelectionMask.initialize(shared, layout.maskOffset, count);
  const kernels = await instantiateHybridKernels(shared.memory);
  let generation = 0;
  {
    using writer = mask.claimWriter();
    writer.clearAll();
    kernels.scan_i32_between_mask(
      absolute(shared, layout.filterOffset),
      count,
      1,
      1,
      absolute(shared, writer.dataByteOffset),
    );
    generation = writer.publish();
  }
  const published = mask.read(generation);
  assert(published.countOnes() === 0, "empty filter");
  kernels.masked_squared_l2_top1_pdx64(
    absolute(shared, layout.vectorsOffset),
    absolute(shared, layout.queryOffset),
    count,
    dimensions,
    absolute(shared, published.dataByteOffset),
    absolute(shared, layout.scratchOffset),
    absolute(shared, layout.resultOffset),
  );
  const result = shared.uint32Array(layout.resultOffset, 3);
  const distance = float32View(shared, layout.resultOffset + 4, 1)[0]!;
  assert(result[0] === 0xffff_ffff, "no result ID");
  assert(result[2] === 0, "no selected candidates");
  assert(distance === Infinity, "no result distance");
});

Deno.test("the same shared filter mask feeds binary Hamming search", async () => {
  const count = 70;
  const stride = 16;
  using owner = await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 2 });
  using consumer = await SharedBuffer.attach(owner.memory);
  const mask = SharedSelectionMask.initialize(owner, 0, count);
  const filterOffset = mask.byteLength;
  const signaturesOffset = alignTo(filterOffset + count * 4, 16);
  const queryOffset = signaturesOffset + count * stride;
  const resultOffset = alignTo(queryOffset + stride, 16);
  const filters = owner.int32Array(filterOffset, count);
  const signatures = owner.uint8Array(signaturesOffset, count * stride);
  const query = owner.uint8Array(queryOffset, stride);
  for (let row = 0; row < count; row++) {
    filters[row] = row;
    signatures.fill(row, row * stride, (row + 1) * stride);
  }
  query.fill(66);

  const producerKernels = await instantiateHybridKernels(owner.memory);
  let generation = 0;
  {
    using writer = mask.claimWriter();
    writer.clearAll();
    producerKernels.scan_i32_between_mask(
      absolute(owner, filterOffset),
      count,
      64,
      69,
      absolute(owner, writer.dataByteOffset),
    );
    generation = writer.publish();
  }

  const published = SharedSelectionMask.attach(consumer, 0).read(generation);
  const consumerKernels = await instantiateHybridKernels(consumer.memory);
  consumerKernels.masked_hamming_top1(
    absolute(consumer, signaturesOffset),
    absolute(consumer, queryOffset),
    count,
    stride,
    absolute(consumer, published.dataByteOffset),
    absolute(consumer, resultOffset),
  );
  const result = consumer.uint32Array(resultOffset, 3);
  assert(result[0] === 66, "nearest binary row");
  assert(result[1] === 0, "Hamming distance");
  assert(result[2] === 5, "selected binary candidates");
});

Deno.test("shared mask generations reuse fixed storage across repeated hybrid queries", async () => {
  const count = 257;
  const dimensions = 7;
  using shared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2 });
  const layout = createLayout(count, dimensions);
  const mask = SharedSelectionMask.initialize(shared, layout.maskOffset, count);
  const filters = shared.int32Array(layout.filterOffset, count);
  const vectors = float32View(shared, layout.vectorsOffset, layout.paddedCount * dimensions);
  const query = float32View(shared, layout.queryOffset, dimensions);
  for (let row = 0; row < count; row++) {
    filters[row] = row % 101 - 50;
    for (let dimension = 0; dimension < dimensions; dimension++) {
      vectors[pdxOffset(row, dimension, dimensions)] = Math.sin(row + dimension * 0.125);
    }
  }
  const kernels = await instantiateHybridKernels(shared.memory);
  using writer = mask.claimWriter();
  const dataByteOffset = writer.dataByteOffset;
  const paddedWords = writer.paddedWords;

  for (let iteration = 0; iteration < 17; iteration++) {
    const minimum = -40 + iteration;
    const maximum = 41 - iteration;
    let target = iteration * 13 % count;
    while (filters[target]! < minimum || filters[target]! >= maximum) {
      target = (target + 1) % count;
    }
    for (let dimension = 0; dimension < dimensions; dimension++) {
      query[dimension] = vectors[pdxOffset(target, dimension, dimensions)]!;
    }
    writer.clearAll();
    kernels.scan_i32_between_mask(
      absolute(shared, layout.filterOffset),
      count,
      minimum,
      maximum,
      absolute(shared, writer.dataByteOffset),
    );
    const generation = writer.publish();
    const published = mask.read(generation);
    kernels.masked_squared_l2_top1_pdx64(
      absolute(shared, layout.vectorsOffset),
      absolute(shared, layout.queryOffset),
      count,
      dimensions,
      absolute(shared, published.dataByteOffset),
      absolute(shared, layout.scratchOffset),
      absolute(shared, layout.resultOffset),
    );
    const result = shared.uint32Array(layout.resultOffset, 3);
    const expectedCount = filters.reduce(
      (total, value) => total + Number(value >= minimum && value < maximum),
      0,
    );
    assert(result[0] === target, `iteration ${iteration}: nearest row`);
    assert(result[2] === expectedCount, `iteration ${iteration}: selected count`);
    assert(published.dataByteOffset === dataByteOffset, "mask storage remains fixed");
    assert(published.paddedWords === paddedWords, "mask width remains fixed");
  }
});

interface Layout {
  readonly maskOffset: number;
  readonly filterOffset: number;
  readonly vectorsOffset: number;
  readonly queryOffset: number;
  readonly scratchOffset: number;
  readonly resultOffset: number;
  readonly paddedCount: number;
}

function createLayout(count: number, dimensions: number): Layout {
  const maskOffset = 0;
  const filterOffset = SharedSelectionMask.byteLengthFor(count);
  const paddedCount = Math.ceil(count / 64) * 64;
  const vectorsOffset = alignTo(filterOffset + count * 4, 16);
  const queryOffset = vectorsOffset + paddedCount * dimensions * 4;
  const scratchOffset = alignTo(queryOffset + dimensions * 4, 16);
  const resultOffset = alignTo(scratchOffset + paddedCount * 4, 16);
  return {
    maskOffset,
    filterOffset,
    vectorsOffset,
    queryOffset,
    scratchOffset,
    resultOffset,
    paddedCount,
  };
}

function pdxOffset(row: number, dimension: number, dimensions: number): number {
  const block = row >>> 6;
  const lane = row & 63;
  return (block * dimensions + dimension) * 64 + lane;
}

function float32View(shared: SharedBuffer, byteOffset: number, length: number): Float32Array {
  return new Float32Array(shared.memory.buffer, absolute(shared, byteOffset), length);
}

function absolute(shared: SharedBuffer, byteOffset: number): number {
  return shared.dataOffset + byteOffset;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
