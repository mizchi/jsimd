import process from "node:process";
import { spawnSync } from "node:child_process";
import { AdaptiveSimdColumnI32, SimdColumnMask } from "../src/adaptive-simd-page-i32/mod.ts";
import {
  BinaryVectorIndex,
  BinaryVectorIndexWithRerank,
  PdxFloat32Index,
} from "../src/binary-vector-index/mod.ts";
import { BitMatrix, SparseBitMatrix } from "../src/bit-matrix/mod.ts";
import { BitSlicedColumnU8, BitSliceMask } from "../src/bit-sliced-column/mod.ts";
import { Bitmap, DenseBitmap } from "../src/bitmap/mod.ts";
import { memory as bytesMemory } from "../src/bytes/kernels.wasm";
import { bytesEqual } from "../src/bytes/mod.ts";
import { ByteKeyFlatHashMapU32 } from "../src/byte-key-flat-hash/mod.ts";
import { CompressedStringTable } from "../src/compressed-string-table/mod.ts";
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
import { FrozenByteMapU32, StaticMphfBytes } from "../src/static-mphf-bytes/mod.ts";
import { StaticMphfU32 } from "../src/static-mphf-u32/mod.ts";
import { WaveletMatrixUint32 } from "../src/wavelet-matrix-uint32/mod.ts";
import { WaveletMatrixUint8 } from "../src/wavelet-matrix-uint8/mod.ts";

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

const i32Values = Int32Array.from(
  { length: U32_LENGTH },
  (_, index) => Math.imul(index, 1_664_525) | 0,
);
const f32Values = Float32Array.from(i32Values, (value) => value / 0x8000_0000);
const u8Values = Uint8Array.from(i32Values, (value) => value & 0xff);
const u32Keys = Uint32Array.from(
  { length: U32_LENGTH },
  (_, index) => Math.imul(index, 0x9e37_79b1) >>> 0,
);
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

let sink = 0;

const scenarios: readonly Scenario[] = [
  {
    name: "bytes-scratch",
    iterations: 250,
    run() {
      sink += Number(bytesEqual(scratchBytes, scratchBytes));
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
      sink += value.dot(value);
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
    name: "static-mphf-bytes",
    iterations: 100,
    run() {
      using value = StaticMphfBytes.from(byteKeys);
      sink += value.lookup(byteKeys[512]!);
    },
    stats: () => StaticMphfBytes.allocatorStats(),
  },
  {
    name: "frozen-byte-map",
    iterations: 100,
    run() {
      using value = FrozenByteMapU32.from(byteEntries);
      sink += value.get(byteKeys[512]!) ?? 0;
    },
    stats: () => FrozenByteMapU32.allocatorStats(),
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
];

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
  const tail = samples.slice(-4);
  const hostPlateau = range(tail.map((value) => value.rss)) <= 2 * 1024 * 1024 &&
    range(tail.map((value) => value.heapUsed)) <= 1024 * 1024 &&
    range(tail.map((value) => value.external)) <= 1024 * 1024;
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
  console.log(JSON.stringify(runScenario(scenario)));
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
