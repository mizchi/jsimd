import process from "node:process";
import { spawnSync } from "node:child_process";
import { AdaptiveSimdColumnI32, SimdColumnMask } from "../src/adaptive-simd-page-i32/mod.ts";
import {
  BinaryVectorIndex,
  BinaryVectorIndexWithRerank,
  PdxFloat32Index,
} from "../src/binary-vector-index/mod.ts";
import { BitMatrix, SparseBitMatrix } from "../src/bit-matrix/mod.ts";
import { BitHistogram32 } from "../src/bit-histogram32/mod.ts";
import { BlockedBloomFilterU32 } from "../src/blocked-bloom-filter/mod.ts";
import { BlockedVectorArray } from "../src/blocked-vector-array/mod.ts";
import { BitSlicedColumnU8, BitSliceMask } from "../src/bit-sliced-column/mod.ts";
import { Bitmap, DenseBitmap } from "../src/bitmap/mod.ts";
import { memory as bytesMemory } from "../src/bytes/kernels.wasm";
import { equals } from "../src/bytes/mod.ts";
import { ByteKeyFlatHashMapU32 } from "../src/byte-key-flat-hash/mod.ts";
import { CompressedStringTable } from "../src/compressed-string-table/mod.ts";
import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "../src/columnar/mod.ts";
import { EliasFanoSequence, PartitionedEliasFanoSequence } from "../src/elias-fano-sequence/mod.ts";
import { memory as endianMemory } from "../src/endian/kernels.wasm";
import { decodeUint32BE } from "../src/endian/mod.ts";
import { SimdFloat32Vector } from "../src/f32-vector/mod.ts";
import { FlatHashMapFixed16U32, FlatHashSetFixed16 } from "../src/flat-hash-fixed16/mod.ts";
import { FlatHashMapU32U32, FlatHashMapU64U32, FlatHashSetU32 } from "../src/flat-hash/mod.ts";
import { FingerprintGroup16, FingerprintTable16 } from "../src/fingerprint-group16/mod.ts";
import { FmIndexBytes } from "../src/fm-index-bytes/mod.ts";
import { SimdInt32Array } from "../src/i32-array/mod.ts";
import { memory as jsonMemory } from "../src/json/kernels.wasm";
import { jsonTokenStarts } from "../src/json/mod.ts";
import { SimdMatrix2D } from "../src/matrix2d/mod.ts";
import { SimdMatrix3D } from "../src/matrix3d/mod.ts";
import { PackedDeltaUint32List } from "../src/packed-delta-uint32-list/mod.ts";
import { RankSelectBitVector } from "../src/rank-select-bit-vector/mod.ts";
import { RoaringBitmap } from "../src/roaring-bitmap/mod.ts";
import {
  AtomicDenseBitmap,
  MpmcRingBufferU32,
  MpmcRingBufferU64,
  ShardedBitmap,
  SharedBlockPool,
  SharedBuffer,
  SharedSlotMap,
  SpscRingBufferU32,
  SpscRingBufferU64,
  StripedHistogram,
  VersionedBuffer,
  WorkStealingDequeU32,
} from "../src/shared-buffer/mod.ts";
import { StaticMphfU32 } from "../src/static-mphf-u32/mod.ts";
import { WaveletMatrixUint32 } from "../src/wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "../src/wavelet-matrix-uint8/mod.ts";
import { WaveletMatrixUint16 } from "../src/wavelet-matrix-uint16/mod.ts";

interface AllocatorStats {
  readonly liveAllocations: number;
  readonly liveBytes: number;
  readonly freeBytes: number;
  readonly reservedBytes: number;
  readonly memoryBytes: number;
}

interface Scenario {
  readonly name: string;
  readonly iterations: number;
  readonly run: () => void;
  readonly stats: () => AllocatorStats;
}

interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly allocator: AllocatorStats;
}

interface ProfileResult {
  readonly name: string;
  readonly cycles: number;
  readonly elapsedMs: number;
  readonly baseline: MemorySample;
  readonly samples: readonly MemorySample[];
  readonly allocatorPlateau: boolean;
  readonly hostPlateau: boolean;
  readonly liveReturned: boolean;
}

const encoder = new TextEncoder();
const U32_LENGTH = 4096;
const VECTOR_COUNT = 256;
const VECTOR_DIMENSIONS = 64;
const ROUNDS = Number(process.env.JSIMD_MEMORY_ROUNDS ?? 16);
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 4) {
  throw new RangeError("JSIMD_MEMORY_ROUNDS must be an integer of at least 4");
}
const requestedScenarioIndex = process.argv.indexOf("--scenario");
const requestedScenario = requestedScenarioIndex >= 0
  ? process.argv[requestedScenarioIndex + 1]
  : undefined;
const sharedPoolBuffer = requestedScenario === "shared-block-pool"
  ? await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 1 })
  : undefined;
const sharedBlockPool = sharedPoolBuffer === undefined
  ? undefined
  : SharedBlockPool.initialize(sharedPoolBuffer, 0);
const sharedRingBuffer = requestedScenario === "shared-spsc-ring"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const sharedRing = sharedRingBuffer === undefined
  ? undefined
  : SpscRingBufferU32.initialize(sharedRingBuffer, 0, 4_096);
const sharedRingValues = Uint32Array.from({ length: 4_096 }, (_, index) => index);
const sharedRingOutput = new Uint32Array(4_096);
const sharedMpmcBuffer = requestedScenario === "shared-mpmc-ring"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const sharedMpmcRing = sharedMpmcBuffer === undefined
  ? undefined
  : MpmcRingBufferU32.initialize(sharedMpmcBuffer, 0, 4_096);
const sharedRingU64Buffer = requestedScenario === "shared-spsc-ring-u64"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const sharedRingU64 = sharedRingU64Buffer === undefined
  ? undefined
  : SpscRingBufferU64.initialize(sharedRingU64Buffer, 0, 2_048);
const sharedMpmcU64Buffer = requestedScenario === "shared-mpmc-ring-u64"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const sharedMpmcU64Ring = sharedMpmcU64Buffer === undefined
  ? undefined
  : MpmcRingBufferU64.initialize(sharedMpmcU64Buffer, 0, 2_048);
const sharedRingU64Values = BigUint64Array.from(
  { length: 2_048 },
  (_, index) => 0x7fff_ffff_0000_0000n | BigInt(index),
);
const sharedRingU64Output = new BigUint64Array(2_048);
const sharedSlotMapBuffer = requestedScenario === "shared-slot-map"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const sharedSlotMap = sharedSlotMapBuffer === undefined
  ? undefined
  : SharedSlotMap.initialize(sharedSlotMapBuffer, 0, {
    capacity: 64,
    payloadByteLength: 32,
  });
const atomicBitmapBuffer = requestedScenario === "atomic-dense-bitmap"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const atomicBitmap = atomicBitmapBuffer === undefined
  ? undefined
  : AtomicDenseBitmap.initialize(atomicBitmapBuffer, 0, 32_768);
const shardedBitmapBuffer = requestedScenario === "sharded-bitmap"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const shardedBitmap = shardedBitmapBuffer === undefined
  ? undefined
  : ShardedBitmap.initialize(shardedBitmapBuffer, 0, { capacity: 8_192, shardCount: 4 });
const stripedHistogramBuffer = requestedScenario === "striped-histogram"
  ? await SharedBuffer.create({ initialPages: 2, maximumPages: 2, maxWorkers: 1 })
  : undefined;
const stripedHistogram = stripedHistogramBuffer === undefined
  ? undefined
  : StripedHistogram.initialize(stripedHistogramBuffer, 0, {
    bucketCount: 2_048,
    stripeCount: 4,
  });
const stripedHistogramOutput = new Uint32Array(2_048);
const versionedBufferBacking = requestedScenario === "versioned-buffer"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const versionedBuffer = versionedBufferBacking === undefined
  ? undefined
  : VersionedBuffer.initialize(versionedBufferBacking, 0, 16_384);
const workDequeBuffer = requestedScenario === "work-stealing-deque"
  ? await SharedBuffer.create({ initialPages: 1, maximumPages: 1, maxWorkers: 1 })
  : undefined;
const workDeque = workDequeBuffer === undefined
  ? undefined
  : WorkStealingDequeU32.initialize(workDequeBuffer, 0, 4_096);
const workDequeValues = Uint32Array.from({ length: 4_096 }, (_, index) => index);
const workDequeOutput = new Uint32Array(4_096);

const i32Values = Int32Array.from(
  { length: U32_LENGTH },
  (_, index) => Math.imul(index, 1_664_525) | 0,
);
const adaptiveRleValues = Int32Array.from(
  { length: U32_LENGTH },
  (_, index) => [-0x8000_0000, 7, 1_000_000, 0x7fff_ffff][(index >>> 6) & 3]!,
);
const adaptiveDictionaryValues = Int32Array.from(
  { length: U32_LENGTH },
  (_, index) => [-0x8000_0000, 7, 1_000_000, 0x7fff_ffff][Math.imul(index, 5) & 3]!,
);
const adaptiveSparseValues = Int32Array.from(
  { length: U32_LENGTH },
  (_, index) => (index & 7) === 0 ? Math.imul(index + 1, 0x6d2b_79f5) | 0 : -7,
);
const f32Values = Float32Array.from(i32Values, (value) => value / 0x8000_0000);
const u8Values = Uint8Array.from(i32Values, (value) => value & 0xff);
const u16Values = Uint16Array.from(i32Values, (value) => value & 0xffff);
const u32Keys = Uint32Array.from(
  { length: U32_LENGTH },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
const histogramCounts = new Uint32Array(32);
const monotoneValues = Uint32Array.from(
  { length: U32_LENGTH },
  (_, index) => index * 3 + Math.floor(index / 7),
);
const bitPositions = Array.from({ length: U32_LENGTH }, (_, index) => index * 29);
const mapEntries = Array.from(
  u32Keys,
  (key, index) => [key, index] as const,
);
const u64Entries = Array.from(
  u32Keys,
  (key, index) => [(BigInt(key) << 32n) | BigInt(index), index] as const,
);
const fixed16Keys = Array.from({ length: 1024 }, (_, index) => {
  const key = new Uint8Array(16);
  const view = new DataView(key.buffer);
  view.setUint32(0, index, true);
  view.setUint32(4, Math.imul(index, 0x9e37_79b1), true);
  view.setUint32(8, Math.imul(index, 0x85eb_ca6b), true);
  view.setUint32(12, Math.imul(index, 0xc2b2_ae35), true);
  return key;
});
const fixed16Entries = fixed16Keys.map((key, index) => [key, index] as const);
const byteKeys = Array.from(
  { length: 1024 },
  (_, index) => encoder.encode(`key/${index}/${Math.imul(index, index)}`),
);
const byteEntries = byteKeys.map((key, index) => [key, index] as const);
const matrixValues = Float32Array.from(
  { length: 32 * 32 },
  (_, index) => ((index * 17) % 31) / 31,
);
const matrix3dValues = Float32Array.from(
  { length: 4 * 16 * 16 },
  (_, index) => ((index * 13) % 29) / 29,
);
const vectorValues = Float32Array.from(
  { length: VECTOR_COUNT * VECTOR_DIMENSIONS },
  (_, index) => ((index * 17) % 101 - 50) / 50,
);
const vectorQuery = vectorValues.slice(0, VECTOR_DIMENSIONS);
const binaryQuery = new Uint8Array(Math.ceil(VECTOR_DIMENSIONS / 8));
for (let dimension = 0; dimension < VECTOR_DIMENSIONS; dimension++) {
  if (vectorQuery[dimension]! > 0) binaryQuery[dimension >>> 3] |= 1 << (dimension & 7);
}
const binaryOutput = new Uint32Array(VECTOR_COUNT);
const pdxOutput = new Float32Array(VECTOR_COUNT);
const topIds = new Uint32Array(16);
const topDistances = new Float32Array(16);
const packedIntersection = new Uint32Array(U32_LENGTH);
const fingerprintControls = Uint8Array.from({ length: 16 }, (_, index) => index);
const fmText = Uint8Array.from(
  { length: 2048 },
  (_, index) => 97 + ((index * 17 + (index >>> 3)) % 23),
);
const fmPattern = fmText.slice(200, 208);
const scratchBytes = Uint8Array.from(
  { length: 128 * 1024 },
  (_, index) => index & 0xff,
);
const jsonBytes = encoder.encode(
  `[${Array.from({ length: 4096 }, (_, index) => `{"id":${index},"ok":true}`).join(",")}]`,
);
const sparseEdges = Array.from(
  { length: U32_LENGTH },
  (_, index) => [index & 1023, Math.imul(index, 17) & 1023] as const,
);
const denseEdges = Array.from(
  { length: 512 },
  (_, index) => [index & 63, Math.imul(index, 13) & 63] as const,
);
const waveletU8Snapshot = makeSnapshot(() => WaveletMatrixUint8.from(u8Values));
const waveletU16Snapshot = makeSnapshot(() => WaveletMatrixUint16.from(u16Values));
const fmSnapshot = makeSnapshot(() => FmIndexBytes.from(fmText));
const compressedStringsSnapshot = makeSnapshot(() => CompressedStringTable.from(byteKeys));
const waveletU32Snapshot = makeSnapshot(() => WaveletMatrixUint32.from(u32Keys));
const eliasFanoSnapshot = makeSnapshot(() => EliasFanoSequence.fromUint32Array(monotoneValues));
const binaryVectorSnapshot = makeSnapshot(() =>
  BinaryVectorIndex.fromFloat32(vectorValues, VECTOR_COUNT, VECTOR_DIMENSIONS)
);
const staticMphfSnapshot = makeSnapshot(() => StaticMphfU32.fromUint32Array(u32Keys));

let sink = 0;

const scenarios: readonly Scenario[] = [
  {
    name: "work-stealing-deque",
    iterations: 250,
    run() {
      if (workDeque === undefined) throw new Error("work-stealing deque profile not initialized");
      using owner = workDeque.owner();
      if (owner.pushMany(workDequeValues) !== workDequeValues.length) {
        throw new Error("work-stealing deque profile push was incomplete");
      }
      if (owner.popMany(workDequeOutput) !== workDequeOutput.length) {
        throw new Error("work-stealing deque profile pop was incomplete");
      }
      sink += workDequeOutput[0]!;
    },
    stats: () => sharedQueueStats(workDequeBuffer, "work-stealing deque"),
  },
  {
    name: "versioned-buffer",
    iterations: 250,
    run() {
      if (versionedBuffer === undefined) {
        throw new Error("versioned buffer profile not initialized");
      }
      {
        using writer = versionedBuffer.beginWrite();
        writer.bytes.fill(sink & 0xff);
        writer.publish();
      }
      using snapshot = versionedBuffer.acquire();
      sink += snapshot.bytes[0]!;
    },
    stats: () => sharedQueueStats(versionedBufferBacking, "versioned buffer"),
  },
  {
    name: "striped-histogram",
    iterations: 250,
    run() {
      if (stripedHistogram === undefined) {
        throw new Error("striped histogram profile not initialized");
      }
      for (let stripeIndex = 0; stripeIndex < stripedHistogram.stripeCount; stripeIndex++) {
        using stripe = stripedHistogram.claimStripe(stripeIndex);
        stripe.clearAll();
        for (let bucket = stripeIndex; bucket < stripedHistogram.bucketCount; bucket += 4) {
          stripe.increment(bucket);
        }
      }
      stripedHistogram.reduceInto(stripedHistogramOutput);
      sink += stripedHistogramOutput[sink & (stripedHistogram.bucketCount - 1)]!;
    },
    stats: () => sharedQueueStats(stripedHistogramBuffer, "striped histogram"),
  },
  {
    name: "sharded-bitmap",
    iterations: 250,
    run() {
      if (shardedBitmap === undefined) throw new Error("sharded bitmap profile not initialized");
      for (let shardIndex = 0; shardIndex < shardedBitmap.shardCount; shardIndex++) {
        using shard = shardedBitmap.claimShard(shardIndex);
        shard.clearAll();
        for (let bit = shardIndex; bit < shardedBitmap.capacity; bit += 32) shard.set(bit);
      }
      sink += shardedBitmap.reduceOr().countOnes();
      sink += shardedBitmap.reduceAnd().countOnes();
    },
    stats: () => sharedQueueStats(shardedBitmapBuffer, "sharded bitmap"),
  },
  {
    name: "atomic-dense-bitmap",
    iterations: 250,
    run() {
      if (atomicBitmap === undefined) throw new Error("atomic bitmap profile not initialized");
      for (let bit = 0; bit < atomicBitmap.capacity; bit += 8) atomicBitmap.set(bit);
      for (let bit = 0; bit < atomicBitmap.capacity; bit += 8) atomicBitmap.clear(bit);
      sink += Number(atomicBitmap.has(0));
    },
    stats: () => sharedQueueStats(atomicBitmapBuffer, "atomic bitmap"),
  },
  {
    name: "shared-mpmc-ring-u64",
    iterations: 250,
    run() {
      if (sharedMpmcU64Ring === undefined) {
        throw new Error("shared u64 MPMC profile not initialized");
      }
      if (sharedMpmcU64Ring.pushMany(sharedRingU64Values) !== sharedRingU64Values.length) {
        throw new Error("shared u64 MPMC profile push was incomplete");
      }
      if (sharedMpmcU64Ring.popMany(sharedRingU64Output) !== sharedRingU64Output.length) {
        throw new Error("shared u64 MPMC profile pop was incomplete");
      }
      sink += Number(sharedRingU64Output[sharedRingU64Output.length - 1]! & 0xffffn);
    },
    stats: () => sharedQueueStats(sharedMpmcU64Buffer, "shared u64 MPMC"),
  },
  {
    name: "shared-spsc-ring-u64",
    iterations: 250,
    run() {
      if (sharedRingU64 === undefined) throw new Error("shared u64 SPSC profile not initialized");
      using producer = sharedRingU64.producer();
      using consumer = sharedRingU64.consumer();
      if (producer.pushMany(sharedRingU64Values) !== sharedRingU64Values.length) {
        throw new Error("shared u64 SPSC profile push was incomplete");
      }
      if (consumer.popMany(sharedRingU64Output) !== sharedRingU64Output.length) {
        throw new Error("shared u64 SPSC profile pop was incomplete");
      }
      sink += Number(sharedRingU64Output[sharedRingU64Output.length - 1]! & 0xffffn);
    },
    stats: () => sharedQueueStats(sharedRingU64Buffer, "shared u64 SPSC"),
  },
  {
    name: "shared-slot-map",
    iterations: 250,
    run() {
      if (sharedSlotMap === undefined) throw new Error("shared slot map profile not initialized");
      const slots = Array.from({ length: sharedSlotMap.capacity }, () => sharedSlotMap.allocate());
      for (const slot of slots) {
        slot.uint32Array(0, 1)[0] = slot.index;
        slot[Symbol.dispose]();
      }
      sink += sharedSlotMap.outstandingSlots;
    },
    stats: () => {
      if (sharedSlotMap === undefined || sharedSlotMapBuffer === undefined) {
        throw new Error("shared slot map profile not initialized");
      }
      return {
        liveAllocations: sharedSlotMap.outstandingSlots,
        liveBytes: sharedSlotMap.outstandingSlots * sharedSlotMap.payloadByteLength,
        freeBytes: (sharedSlotMap.capacity - sharedSlotMap.outstandingSlots) *
          sharedSlotMap.slotStride,
        reservedBytes: sharedSlotMap.byteLength,
        memoryBytes: sharedSlotMapBuffer.memory.buffer.byteLength,
      };
    },
  },
  {
    name: "shared-mpmc-ring",
    iterations: 250,
    run() {
      if (sharedMpmcRing === undefined) throw new Error("shared MPMC ring profile not initialized");
      if (sharedMpmcRing.pushMany(sharedRingValues) !== sharedRingValues.length) {
        throw new Error("shared MPMC profile push was incomplete");
      }
      if (sharedMpmcRing.popMany(sharedRingOutput) !== sharedRingOutput.length) {
        throw new Error("shared MPMC profile pop was incomplete");
      }
      sink += sharedRingOutput[sharedRingOutput.length - 1]!;
    },
    stats: () => {
      if (sharedMpmcBuffer === undefined) {
        throw new Error("shared MPMC ring profile not initialized");
      }
      return {
        liveAllocations: 0,
        liveBytes: 0,
        freeBytes: sharedMpmcBuffer.byteLength,
        reservedBytes: sharedMpmcBuffer.byteLength,
        memoryBytes: sharedMpmcBuffer.memory.buffer.byteLength,
      };
    },
  },
  {
    name: "shared-spsc-ring",
    iterations: 250,
    run() {
      if (sharedRing === undefined) throw new Error("shared SPSC ring profile not initialized");
      using producer = sharedRing.producer();
      using consumer = sharedRing.consumer();
      if (producer.pushMany(sharedRingValues) !== sharedRingValues.length) {
        throw new Error("shared SPSC profile push was incomplete");
      }
      if (consumer.popMany(sharedRingOutput) !== sharedRingOutput.length) {
        throw new Error("shared SPSC profile pop was incomplete");
      }
      sink += sharedRingOutput[sharedRingOutput.length - 1]!;
    },
    stats: () => {
      if (sharedRingBuffer === undefined) {
        throw new Error("shared SPSC ring profile not initialized");
      }
      return {
        liveAllocations: 0,
        liveBytes: 0,
        freeBytes: sharedRingBuffer.byteLength,
        reservedBytes: sharedRingBuffer.byteLength,
        memoryBytes: sharedRingBuffer.memory.buffer.byteLength,
      };
    },
  },
  {
    name: "shared-block-pool",
    iterations: 250,
    run() {
      if (sharedBlockPool === undefined) {
        throw new Error("shared block pool profile not initialized");
      }
      const blocks = Array.from({ length: 32 }, () => sharedBlockPool.allocate(256));
      for (const block of blocks) block[Symbol.dispose]();
      sink += sharedBlockPool.reservedBytes;
    },
    stats: () => {
      if (sharedBlockPool === undefined || sharedPoolBuffer === undefined) {
        throw new Error("shared block pool profile not initialized");
      }
      return {
        liveAllocations: sharedBlockPool.outstandingBlocks,
        liveBytes: 0,
        freeBytes: sharedBlockPool.reservedBytes,
        reservedBytes: sharedBlockPool.reservedBytes,
        memoryBytes: sharedPoolBuffer.memory.buffer.byteLength,
      };
    },
  },
  {
    name: "bytes-scratch",
    iterations: 250,
    run() {
      sink += Number(equals(scratchBytes, scratchBytes));
    },
    stats: () => scratchStats(bytesMemory),
  },
  {
    name: "endian-scratch",
    iterations: 100,
    run() {
      sink += decodeUint32BE(scratchBytes)[0]!;
    },
    stats: () => scratchStats(endianMemory),
  },
  {
    name: "json-scratch",
    iterations: 100,
    run() {
      sink += jsonTokenStarts(jsonBytes).length;
    },
    stats: () => scratchStats(jsonMemory),
  },
  {
    name: "f32-vector",
    iterations: 500,
    run() {
      using value = SimdFloat32Vector.from(f32Values);
      sink += value.cosineSimilarity(value);
    },
    stats: () => SimdFloat32Vector.allocatorStats(),
  },
  {
    name: "i32-array",
    iterations: 500,
    run() {
      using value = SimdInt32Array.from(i32Values);
      sink += value.sum();
    },
    stats: () => SimdInt32Array.allocatorStats(),
  },
  {
    name: "matrix2d",
    iterations: 100,
    run() {
      using left = SimdMatrix2D.from(32, 32, matrixValues);
      using product = left.multiply(left);
      sink += product.get(0, 0);
    },
    stats: () => SimdMatrix2D.allocatorStats(),
  },
  {
    name: "matrix3d",
    iterations: 100,
    run() {
      using left = SimdMatrix3D.from(4, 16, 16, matrix3dValues);
      using product = left.batchMultiply(left);
      sink += product.get(0, 0, 0);
    },
    stats: () => SimdMatrix3D.allocatorStats(),
  },
  {
    name: "rank-select-bit-vector",
    iterations: 250,
    run() {
      using value = RankSelectBitVector.from(131_072, bitPositions);
      sink += value.rank1(65_536);
    },
    stats: () => RankSelectBitVector.allocatorStats(),
  },
  {
    name: "roaring-bitmap",
    iterations: 100,
    run() {
      using left = RoaringBitmap.from(u32Keys);
      using right = RoaringBitmap.from(u32Keys.subarray(0, 3072));
      using intersection = left.and(right);
      sink += intersection.size;
    },
    stats: () => RoaringBitmap.allocatorStats(),
  },
  {
    name: "blocked-bloom-filter",
    iterations: 250,
    run() {
      using value = BlockedBloomFilterU32.from(u32Keys, 12);
      const output = new Uint8Array(u32Keys.length);
      sink += value.mayContainMany(u32Keys, output);
    },
    stats: () => BlockedBloomFilterU32.allocatorStats(),
  },
  {
    name: "packed-delta",
    iterations: 250,
    run() {
      using left = PackedDeltaUint32List.fromUint32Array(monotoneValues);
      using right = PackedDeltaUint32List.fromUint32Array(monotoneValues.subarray(1024));
      sink += left.intersectInto(right, packedIntersection);
    },
    stats: () => PackedDeltaUint32List.allocatorStats(),
  },
  {
    name: "flat-hash-set-u32",
    iterations: 250,
    run() {
      using value = FlatHashSetU32.from(u32Keys);
      sink += Number(value.has(u32Keys[2048]!));
    },
    stats: () => FlatHashSetU32.allocatorStats(),
  },
  {
    name: "flat-hash-map-u32",
    iterations: 250,
    run() {
      using value = FlatHashMapU32U32.from(mapEntries);
      sink += value.get(u32Keys[2048]!) ?? 0;
    },
    stats: () => FlatHashMapU32U32.allocatorStats(),
  },
  {
    name: "flat-hash-map-u64",
    iterations: 250,
    run() {
      using value = FlatHashMapU64U32.from(u64Entries);
      sink += value.get(u64Entries[2048]![0]) ?? 0;
    },
    stats: () => FlatHashMapU64U32.allocatorStats(),
  },
  {
    name: "fingerprint-group16",
    iterations: 500,
    run() {
      using value = FingerprintGroup16.from(fingerprintControls);
      sink += value.matchMask(7);
    },
    stats: () => FingerprintGroup16.allocatorStats(),
  },
  {
    name: "fingerprint-table16",
    iterations: 500,
    run() {
      using value = new FingerprintTable16(1024);
      for (let index = 0; index < 128; index++) value.setControl(index, index & 0x7f);
      sink += value.matchMask(0, 7);
    },
    stats: () => FingerprintTable16.allocatorStats(),
  },
  {
    name: "flat-hash-map-fixed16",
    iterations: 150,
    run() {
      using value = FlatHashMapFixed16U32.from(fixed16Entries);
      sink += value.get(fixed16Keys[512]!) ?? 0;
    },
    stats: () => FlatHashMapFixed16U32.allocatorStats(),
  },
  {
    name: "flat-hash-set-fixed16",
    iterations: 150,
    run() {
      using value = FlatHashSetFixed16.from(fixed16Keys);
      sink += Number(value.has(fixed16Keys[512]!));
    },
    stats: () => FlatHashSetFixed16.allocatorStats(),
  },
  {
    name: "byte-key-flat-hash",
    iterations: 150,
    run() {
      using value = ByteKeyFlatHashMapU32.from(byteEntries);
      sink += value.get(byteKeys[512]!) ?? 0;
    },
    stats: () => ByteKeyFlatHashMapU32.allocatorStats(),
  },
  {
    name: "bit-sliced-column",
    iterations: 250,
    run() {
      using value = BitSlicedColumnU8.from(u8Values);
      using mask = new BitSliceMask(value.length);
      sink += value.between(50, 150, mask).countOnes();
    },
    stats: () => BitSlicedColumnU8.allocatorStats(),
  },
  {
    name: "columnar",
    iterations: 250,
    run() {
      using numbers = AdaptiveI32Column.from(i32Values);
      using categories = BitSlicedU8Column.from(u8Values);
      using output = new SelectionMask(U32_LENGTH);
      using temporary = new SelectionMask(U32_LENGTH);
      numbers.scanLt(1_000_000, output);
      categories.scanBetween(50, 150, temporary);
      sink += output.andAssign(temporary).countOnes();
    },
    stats: () => SelectionMask.allocatorStats(),
  },
  {
    name: "columnar-u32",
    iterations: 100,
    run() {
      using unsigned = AdaptiveU32Column.from(u32Keys);
      using output = new SelectionMask(U32_LENGTH);
      sink += unsigned.scanBetween(0x4000_0000, 0xc000_0000, output).countOnes();
    },
    stats: () => AdaptiveU32Column.allocatorStats(),
  },
  {
    name: "dense-bitmap",
    iterations: 250,
    run() {
      using left = DenseBitmap.from(131_072, bitPositions);
      using right = DenseBitmap.from(131_072, bitPositions.slice(1024));
      sink += left.intersectionCount(right);
    },
    stats: () => DenseBitmap.allocatorStats(),
  },
  {
    name: "bitmap",
    iterations: 250,
    run() {
      using left = Bitmap.from(bitPositions);
      using right = Bitmap.from(bitPositions.slice(1024));
      sink += left.intersectionCount(right);
    },
    stats: () => Bitmap.allocatorStats(),
  },
  {
    name: "wavelet-matrix-u8",
    iterations: 50,
    run() {
      using value = WaveletMatrixUint8.from(u8Values);
      sink += value.quantile(0, value.length, value.length >>> 1);
    },
    stats: () => WaveletMatrixUint8.allocatorStats(),
  },
  {
    name: "wavelet-matrix-u16",
    iterations: 35,
    run() {
      using value = WaveletMatrixUint16.from(u16Values);
      sink += value.quantile(0, value.length, value.length >>> 1);
    },
    stats: () => WaveletMatrixUint16.allocatorStats(),
  },
  {
    name: "fm-index-bytes",
    iterations: 20,
    run() {
      using value = FmIndexBytes.from(fmText);
      sink += value.count(fmPattern);
    },
    stats: () => FmIndexBytes.allocatorStats(),
  },
  {
    name: "compressed-string-table",
    iterations: 100,
    run() {
      using value = CompressedStringTable.from(byteKeys);
      sink += Number(value.equals(512, byteKeys[512]!));
    },
    stats: () => CompressedStringTable.allocatorStats(),
  },
  {
    name: "wavelet-matrix-u32",
    iterations: 25,
    run() {
      using value = WaveletMatrixUint32.from(u32Keys);
      sink += value.quantile(0, value.length, value.length >>> 1);
    },
    stats: () => WaveletMatrixUint32.allocatorStats(),
  },
  {
    name: "elias-fano",
    iterations: 100,
    run() {
      using value = EliasFanoSequence.fromUint32Array(monotoneValues);
      sink += value.rank(4096);
    },
    stats: () => EliasFanoSequence.allocatorStats(),
  },
  {
    name: "partitioned-elias-fano",
    iterations: 100,
    run() {
      using value = PartitionedEliasFanoSequence.fromUint32Array(monotoneValues);
      sink += value.rank(4096);
    },
    stats: () => PartitionedEliasFanoSequence.allocatorStats(),
  },
  {
    name: "binary-vector-index",
    iterations: 100,
    run() {
      using value = BinaryVectorIndex.fromFloat32(
        vectorValues,
        VECTOR_COUNT,
        VECTOR_DIMENSIONS,
      );
      sink += value.distanceMany(binaryQuery, binaryOutput)[0]!;
    },
    stats: () => BinaryVectorIndex.allocatorStats(),
  },
  {
    name: "pdx-float32-index",
    iterations: 100,
    run() {
      using value = PdxFloat32Index.from(vectorValues, VECTOR_COUNT, VECTOR_DIMENSIONS);
      sink += value.distanceMany(vectorQuery, pdxOutput)[0]!;
    },
    stats: () => PdxFloat32Index.allocatorStats(),
  },
  {
    name: "blocked-vector-array",
    iterations: 100,
    run() {
      using value = BlockedVectorArray.from(vectorValues, VECTOR_COUNT, VECTOR_DIMENSIONS);
      sink += value.topKInto(vectorQuery, topIds, topDistances);
      sink += value.l1DistanceMany(vectorQuery, pdxOutput)[0]!;
      sink += value.innerProductMany(vectorQuery, pdxOutput)[0]!;
      sink += value.topKInnerProductInto(vectorQuery, topIds, topDistances);
    },
    stats: () => BlockedVectorArray.allocatorStats(),
  },
  {
    name: "bit-histogram32",
    iterations: 500,
    run() {
      using value = new BitHistogram32();
      value.add(u32Keys).writeInto(histogramCounts);
      sink += histogramCounts[0]!;
    },
    stats: () => BitHistogram32.allocatorStats(),
  },
  {
    name: "binary-rerank-index",
    iterations: 100,
    run() {
      using value = BinaryVectorIndexWithRerank.fromFloat32(
        vectorValues,
        VECTOR_COUNT,
        VECTOR_DIMENSIONS,
      );
      sink += value.topK(vectorQuery, 16, 64, topIds, topDistances);
    },
    stats: () => BinaryVectorIndex.allocatorStats(),
  },
  {
    name: "static-mphf-u32",
    iterations: 100,
    run() {
      using value = StaticMphfU32.fromUint32Array(u32Keys);
      sink += value.lookup(u32Keys[2048]!);
    },
    stats: () => StaticMphfU32.allocatorStats(),
  },
  {
    name: "adaptive-column",
    iterations: 250,
    run() {
      using value = AdaptiveSimdColumnI32.from(i32Values);
      using mask = new SimdColumnMask(value.length, value.pageSize);
      sink += value.scanLt(0, mask).countOnes();
    },
    stats: () => AdaptiveSimdColumnI32.allocatorStats(),
  },
  {
    name: "adaptive-rle-column",
    iterations: 250,
    run() {
      using value = AdaptiveSimdColumnI32.from(adaptiveRleValues);
      using mask = new SimdColumnMask(value.length, value.pageSize);
      sink += value.scanBetween(0, 2_000_000, mask).countOnes();
    },
    stats: () => AdaptiveSimdColumnI32.allocatorStats(),
  },
  {
    name: "adaptive-dictionary-column",
    iterations: 500,
    run() {
      using value = AdaptiveSimdColumnI32.from(adaptiveDictionaryValues);
      using mask = new SimdColumnMask(value.length, value.pageSize);
      sink += value.scanBetween(0, 2_000_000, mask).countOnes();
    },
    stats: () => AdaptiveSimdColumnI32.allocatorStats(),
  },
  {
    name: "adaptive-sparse-column",
    iterations: 1000,
    run() {
      using value = AdaptiveSimdColumnI32.from(adaptiveSparseValues);
      using mask = new SimdColumnMask(value.length, value.pageSize);
      sink += value.scanBetween(-7, -6, mask).countOnes();
    },
    stats: () => AdaptiveSimdColumnI32.allocatorStats(),
  },
  {
    name: "bit-matrix",
    iterations: 100,
    run() {
      using value = BitMatrix.fromEdges(64, 64, denseEdges);
      using product = value.multiply(value);
      sink += product.countRowOnes(0);
    },
    stats: () => BitMatrix.allocatorStats(),
  },
  {
    name: "sparse-bit-matrix",
    iterations: 250,
    run() {
      using value = SparseBitMatrix.fromEdges(1024, 1024, sparseEdges);
      sink += Number(value.has(17, Math.imul(17, 17) & 1023));
    },
    stats: () => SparseBitMatrix.allocatorStats(),
  },
  {
    name: "snapshot-wavelet-matrix-u8",
    iterations: 500,
    run() {
      using value = WaveletMatrixUint8.fromSnapshot(waveletU8Snapshot);
      sink += value.length;
    },
    stats: () => WaveletMatrixUint8.allocatorStats(),
  },
  {
    name: "snapshot-wavelet-matrix-u16",
    iterations: 350,
    run() {
      using value = WaveletMatrixUint16.fromSnapshot(waveletU16Snapshot);
      sink += value.length;
    },
    stats: () => WaveletMatrixUint16.allocatorStats(),
  },
  {
    name: "snapshot-fm-index-bytes",
    iterations: 250,
    run() {
      using value = FmIndexBytes.fromSnapshot(fmSnapshot);
      sink += value.length;
    },
    stats: () => FmIndexBytes.allocatorStats(),
  },
  {
    name: "snapshot-compressed-string-table",
    iterations: 500,
    run() {
      using value = CompressedStringTable.fromSnapshot(compressedStringsSnapshot);
      sink += value.length;
    },
    stats: () => CompressedStringTable.allocatorStats(),
  },
  {
    name: "snapshot-wavelet-matrix-u32",
    iterations: 250,
    run() {
      using value = WaveletMatrixUint32.fromSnapshot(waveletU32Snapshot);
      sink += value.length;
    },
    stats: () => WaveletMatrixUint32.allocatorStats(),
  },
  {
    name: "snapshot-elias-fano",
    iterations: 500,
    run() {
      using value = EliasFanoSequence.fromSnapshot(eliasFanoSnapshot);
      sink += value.length;
    },
    stats: () => EliasFanoSequence.allocatorStats(),
  },
  {
    name: "snapshot-binary-vector-index",
    iterations: 500,
    run() {
      using value = BinaryVectorIndex.fromSnapshot(binaryVectorSnapshot);
      sink += value.length;
    },
    stats: () => BinaryVectorIndex.allocatorStats(),
  },
  {
    name: "snapshot-static-mphf-u32",
    iterations: 500,
    run() {
      using value = StaticMphfU32.fromSnapshot(staticMphfSnapshot);
      sink += value.length;
    },
    stats: () => StaticMphfU32.allocatorStats(),
  },
];

function sharedQueueStats(buffer: SharedBuffer | undefined, name: string): AllocatorStats {
  if (buffer === undefined) throw new Error(`${name} profile not initialized`);
  return {
    liveAllocations: 0,
    liveBytes: 0,
    freeBytes: buffer.byteLength,
    reservedBytes: buffer.byteLength,
    memoryBytes: buffer.memory.buffer.byteLength,
  };
}

function makeSnapshot<T extends Disposable & { serialize(): Uint8Array }>(build: () => T) {
  using value = build();
  return value.serialize();
}

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error("run Node with --expose-gc");
  gc();
  gc();
}

function scratchStats(memory: WebAssembly.Memory): AllocatorStats {
  return {
    liveAllocations: 0,
    liveBytes: 0,
    freeBytes: memory.buffer.byteLength,
    reservedBytes: memory.buffer.byteLength,
    memoryBytes: memory.buffer.byteLength,
  };
}

function sample(stats: () => AllocatorStats): MemorySample {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    allocator: stats(),
  };
}

function samePlateau(left: AllocatorStats, right: AllocatorStats): boolean {
  return left.reservedBytes === right.reservedBytes &&
    left.memoryBytes === right.memoryBytes;
}

function runScenario(scenario: Scenario): ProfileResult {
  forceGc();
  const baseline = sample(scenario.stats);
  const samples: MemorySample[] = [];
  const start = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    for (let iteration = 0; iteration < scenario.iterations; iteration++) scenario.run();
    forceGc();
    samples.push(sample(scenario.stats));
  }
  const liveReturned = samples.every((value) =>
    value.allocator.liveAllocations === baseline.allocator.liveAllocations &&
    value.allocator.liveBytes === baseline.allocator.liveBytes
  );
  const allocatorPlateau = samples.slice(1).every((value) =>
    samePlateau(value.allocator, samples[0]!.allocator)
  );
  // Compare the final three post-GC generations. RSS remains an informational high-water mark:
  // V8/Wasm tier-up and libc can retain code or arena pages even when owned storage is released.
  const tail = samples.slice(-3);
  const hostPlateau = range(tail.map((value) => value.heapUsed)) <= 1024 * 1024 &&
    range(tail.map((value) => value.external)) <= 1024 * 1024 &&
    range(tail.map((value) => value.arrayBuffers)) <= 1024 * 1024;
  return {
    name: scenario.name,
    cycles: scenario.iterations * ROUNDS,
    elapsedMs: performance.now() - start,
    baseline,
    samples,
    allocatorPlateau,
    hostPlateau,
    liveReturned,
  };
}

function range(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function printReport(results: readonly ProfileResult[]): void {
  console.log(
    "| structure | cycles | peak RSS +MiB | live heap +KiB | reserved KiB | result |",
  );
  console.log("| :-- | --: | --: | --: | --: | :-- |");
  for (const result of results) {
    const peakRss = Math.max(...result.samples.map((value) => value.rss));
    const finalSample = result.samples.at(-1)!;
    const finalStats = finalSample.allocator;
    const allocatorOk = result.liveReturned && result.allocatorPlateau;
    const status = !allocatorOk ? "allocator-leak" : result.hostPlateau ? "ok" : "host-growth";
    console.log(
      `| ${result.name} | ${result.cycles} | ${formatMiB(peakRss - result.baseline.rss)} | ` +
        `${((finalSample.heapUsed - result.baseline.heapUsed) / 1024).toFixed(1)} | ` +
        `${(finalStats.reservedBytes / 1024).toFixed(1)} | ${status} |`,
    );
  }
}

const scenarioArgument = process.argv.indexOf("--scenario");
if (scenarioArgument >= 0) {
  const name = process.argv[scenarioArgument + 1];
  const scenario = scenarios.find((value) => value.name === name);
  if (scenario === undefined) throw new Error(`unknown memory scenario: ${name}`);
  const result = runScenario(scenario);
  sharedPoolBuffer?.[Symbol.dispose]();
  console.log(JSON.stringify(result));
} else {
  const results: ProfileResult[] = [];
  for (const scenario of scenarios) {
    const child = spawnSync(
      process.execPath,
      ["--no-warnings", "--expose-gc", import.meta.filename, "--scenario", scenario.name],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (child.status !== 0) {
      process.stderr.write(child.stderr);
      throw new Error(`memory scenario failed: ${scenario.name}`);
    }
    results.push(JSON.parse(child.stdout.trim()) as ProfileResult);
  }
  printReport(results);
  if (
    results.some((result) =>
      !result.liveReturned || !result.allocatorPlateau || !result.hostPlateau
    )
  ) {
    process.exitCode = 1;
  }
  if (sink === Number.NEGATIVE_INFINITY) console.error("unreachable");
}
