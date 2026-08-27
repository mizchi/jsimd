import { afterAll, bench, describe } from "vitest";
import {
  ShardedBitmap,
  SharedBlockPool,
  SharedBuffer,
  StripedHistogram,
} from "../../src/shared-buffer/mod.ts";

const LENGTH = 262_144;
const shared = await SharedBuffer.create({ initialPages: 17, maximumPages: 17, maxWorkers: 1 });
const words = shared.uint32Array(0, LENGTH);
const poolShared = await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 1 });
const pool = SharedBlockPool.initialize(poolShared, 0);
const shardedShared = await SharedBuffer.create({
  initialPages: 12,
  maximumPages: 12,
  maxWorkers: 1,
});
const sharded = ShardedBitmap.initialize(shardedShared, 0, {
  capacity: 1_048_576,
  shardCount: 4,
});
const shardStrideWords = sharded.shardStride / Uint32Array.BYTES_PER_ELEMENT;
const shardWords = shardedShared.uint32Array(
  sharded.dataByteOffset,
  sharded.shardCount * shardStrideWords,
);
const reductionWords = shardedShared.uint32Array(sharded.resultByteOffset, sharded.paddedWords);
for (let shard = 0; shard < sharded.shardCount; shard++) {
  for (let word = 0; word < sharded.wordCount; word++) {
    shardWords[shard * shardStrideWords + word] = Math.imul(word + 1, shard * 0x9e37_79b1 + 1);
  }
}
const histogramShared = await SharedBuffer.create({
  initialPages: 12,
  maximumPages: 12,
  maxWorkers: 1,
});
const histogram = StripedHistogram.initialize(histogramShared, 0, {
  bucketCount: 32_768,
  stripeCount: 4,
});
const histogramStrideWords = histogram.stripeStride / Uint32Array.BYTES_PER_ELEMENT;
const histogramWords = histogramShared.uint32Array(
  histogram.dataByteOffset,
  histogram.stripeCount * histogramStrideWords,
);
const histogramOutput = new Uint32Array(histogram.bucketCount);
for (let stripe = 0; stripe < histogram.stripeCount; stripe++) {
  for (let bucket = 0; bucket < histogram.bucketCount; bucket++) {
    histogramWords[stripe * histogramStrideWords + bucket] = bucket + stripe;
  }
}
let value = 0;

afterAll(() => {
  poolShared[Symbol.dispose]();
  shardedShared[Symbol.dispose]();
  histogramShared[Symbol.dispose]();
  shared[Symbol.dispose]();
});

describe("SharedBuffer owner-only fill", () => {
  for (const length of [64, 1_024, LENGTH]) {
    bench(`Wasm SIMD fill x${length}`, () => {
      shared.fillUint32(0, length, value++ >>> 0);
    });
    bench(`Shared Uint32Array.fill x${length}`, () => {
      words.subarray(0, length).fill(value++ >>> 0);
    });
  }
});

describe("SharedBlockPool local allocation", () => {
  bench("SharedBlockPool allocate/release 256 B", () => {
    using block = pool.allocate(256);
    block.uint8Array(0, 1)[0] = value++ & 0xff;
  });
  bench("new Uint8Array 256 B", () => {
    const block = new Uint8Array(256);
    block[0] = value++ & 0xff;
  });
});

describe("ShardedBitmap resident reduction x4 shards x1,048,576 bits", () => {
  bench("Wasm SIMD OR reduction", () => {
    value += sharded.reduceOr().has(value & (sharded.capacity - 1)) ? 1 : 0;
  });
  bench("scalar Shared Uint32Array OR reduction", () => {
    for (let word = 0; word < sharded.wordCount; word++) {
      let reduced = 0;
      for (let shard = 0; shard < sharded.shardCount; shard++) {
        reduced |= shardWords[shard * shardStrideWords + word]!;
      }
      reductionWords[word] = reduced >>> 0;
    }
    value += reductionWords[value & (sharded.wordCount - 1)]! & 1;
  });
  bench("Wasm SIMD AND reduction", () => {
    value += sharded.reduceAnd().has(value & (sharded.capacity - 1)) ? 1 : 0;
  });
  bench("scalar Shared Uint32Array AND reduction", () => {
    for (let word = 0; word < sharded.wordCount; word++) {
      let reduced = 0xffff_ffff;
      for (let shard = 0; shard < sharded.shardCount; shard++) {
        reduced &= shardWords[shard * shardStrideWords + word]!;
      }
      reductionWords[word] = reduced >>> 0;
    }
    value += reductionWords[value & (sharded.wordCount - 1)]! & 1;
  });
});

describe("StripedHistogram resident reduction x4 stripes x32,768 buckets", () => {
  bench("Wasm SIMD u32 sum reduction", () => {
    histogram.reduceInto(histogramOutput);
    value += histogramOutput[value & (histogram.bucketCount - 1)]! & 1;
  });
  bench("scalar Shared Uint32Array u32 sum reduction", () => {
    for (let bucket = 0; bucket < histogram.bucketCount; bucket++) {
      let sum = 0;
      for (let stripe = 0; stripe < histogram.stripeCount; stripe++) {
        sum += histogramWords[stripe * histogramStrideWords + bucket]!;
      }
      histogramOutput[bucket] = sum >>> 0;
    }
    value += histogramOutput[value & (histogram.bucketCount - 1)]! & 1;
  });
});
