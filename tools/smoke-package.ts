const packageDirectory = new URL("../packages/jsimd/", import.meta.url);
const metadata = JSON.parse(await Deno.readTextFile(new URL("package.json", packageDirectory))) as {
  name: string;
  version: string;
};
const temporaryDirectory = await Deno.makeTempDir({ prefix: "jsimd-package-smoke-" });

try {
  const packed = await run(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    packageDirectory.pathname,
  );
  const archive = packed.trim().split("\n").at(-1);
  if (!archive) throw new Error("npm pack did not report an archive");
  await run(
    "npm",
    ["install", "--silent", "--ignore-scripts", `${temporaryDirectory}/${archive}`],
    temporaryDirectory,
  );

  const expression =
    `import { indexOf } from "${metadata.name}/bytes"; import { DenseBitmap } from "${metadata.name}/bitmap"; import { BitHistogram32 } from "${metadata.name}/bit-histogram32"; import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector"; import { RoaringBitmap } from "${metadata.name}/roaring-bitmap"; import { SHARED_SYNC_BYTE_LENGTH, SharedBlockPool, SharedBuffer, SharedMutex, SpscRingBufferU32 } from "${metadata.name}/shared-buffer"; import { AdaptiveU32Column, SelectionMask } from "${metadata.name}/columnar"; import { BlockedVectorArray } from "${metadata.name}/blocked-vector-array"; import { WaveletMatrixUint16 } from "${metadata.name}/wavelet-matrix-uint16"; using bits = DenseBitmap.from(128, [1, 10]); using histogram = new BitHistogram32(); using ranked = RankSelectBitVector.from(128, [1, 10]); using roaring = RoaringBitmap.from([1, 10]); using shared = await SharedBuffer.create({maxWorkers: 2}); const sharedMutex = SharedMutex.initialize(shared, 0); sharedMutex.lock(); sharedMutex.unlock(); const sharedPool = SharedBlockPool.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 2); { using block = sharedPool.allocate(256); block.uint8Array()[0] = 1; } const ring = SpscRingBufferU32.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 8, 8); using producer = ring.producer(); using consumer = ring.consumer(); producer.push(42); using column = AdaptiveU32Column.from(new Uint32Array([0xffffffff, 1, 2])); using selected = new SelectionMask(3); using vectors = BlockedVectorArray.from(new Float32Array([0, 1, 1, 0]), 2, 2); using wavelet = WaveletMatrixUint16.from(new Uint16Array([3, 1, 2, 1])); const counts = new Uint32Array(32); histogram.add(new Uint32Array([1, 3])).writeInto(counts); const sharedCounter = shared.uint32Array(SHARED_SYNC_BYTE_LENGTH, 1); Atomics.add(sharedCounter, 0, 1); const distances = new Float32Array(2); const nearestIds = new Uint32Array(1); const nearestDistances = new Float32Array(1); column.scanLt(3, selected); vectors.squaredDistanceMany(new Float32Array([0, 0]), distances); vectors.topKInto(new Float32Array([0, 0]), nearestIds, nearestDistances); if (indexOf(new Uint8Array([1, 2, 3]), 2) !== 1 || counts[0] !== 2 || bits.countOnes() !== 2 || ranked.rank1(128) !== 2 || roaring.size !== 2 || sharedPool.outstandingBlocks !== 0 || consumer.pop() !== 42 || Atomics.load(sharedCounter, 0) !== 1 || selected.countOnes() !== 2 || distances[0] !== 1 || distances[1] !== 1 || nearestIds[0] !== 0 || wavelet.rank(1, 4) !== 2) throw new Error("unexpected SIMD result");`;
  await run("node", ["--input-type=module", "--eval", expression], temporaryDirectory);
  const fusionExpression =
    `import { add, constant, createF32FusionCompiler, input, multiply } from "${metadata.name}/f32-fusion"; using compiler = createF32FusionCompiler({maxModules: 2}); const compiled = await compiler.compile(add(multiply(input(0), constant(2)), constant(1)), 1); const memory = new WebAssembly.Memory({initial: 1}); new Float32Array(memory.buffer, 0, 4).set([1, 2, 3, 4]); const kernel = await compiled.instantiate(memory); kernel.run([0], 64, 4); const output = new Float32Array(memory.buffer, 64, 4); if (output[0] !== 3 || output[3] !== 9) throw new Error("unexpected f32 fusion result");`;
  await run("node", ["--input-type=module", "--eval", fusionExpression], temporaryDirectory);
  const queueExpression =
    `import { AtomicDenseBitmap, MpmcRingBufferU32, MpmcRingBufferU64, SharedBuffer, SharedSlotMap, ShardedBitmap, StripedHistogram, VersionedBuffer, WorkStealingDequeU32 } from "${metadata.name}/shared-buffer"; using shared = await SharedBuffer.create(); const queue = MpmcRingBufferU32.initialize(shared, 0, 8); queue.push(42); const handles = MpmcRingBufferU64.initialize(shared, 256, 8); const slots = SharedSlotMap.initialize(shared, 576, {capacity: 1, payloadByteLength: 16}); const bitmap = AtomicDenseBitmap.initialize(shared, 832, 65); bitmap.set(64); const sharded = ShardedBitmap.initialize(shared, 960, {capacity: 65, shardCount: 2}); { using shard = sharded.claimShard(0); shard.set(64); } const histogram = StripedHistogram.initialize(shared, 1280, {bucketCount: 5, stripeCount: 2}); { using stripe = histogram.claimStripe(0); stripe.add(2, 7); } const histogramOutput = new Uint32Array(5); histogram.reduceInto(histogramOutput); const versions = VersionedBuffer.initialize(shared, 1600, 16); { using writer = versions.beginWrite(); writer.bytes[0] = 9; writer.publish(); } using snapshot = versions.acquire(); const deque = WorkStealingDequeU32.initialize(shared, 1920, 8); { using owner = deque.owner(); owner.tryPush(44); } { using slot = slots.allocate(); slot.uint32Array(0, 1)[0] = 43; handles.push(slot.handle); if (handles.pop() !== slot.handle || slots.get(slot.handle)?.uint32Array(0, 1)[0] !== 43) throw new Error("unexpected slot result"); } if (queue.pop() !== 42 || slots.outstandingSlots !== 0 || !bitmap.has(64) || !sharded.reduceOr().has(64) || histogramOutput[2] !== 7 || snapshot.bytes[0] !== 9 || deque.trySteal() !== 44) throw new Error("unexpected shared result");`;
  await run("node", ["--input-type=module", "--eval", queueExpression], temporaryDirectory);
  const ultraLogLogExpression =
    `import { UltraLogLogU32 } from "${metadata.name}/ultra-log-log"; import { ParallelUltraLogLogU32 } from "${metadata.name}/ultra-log-log-parallel"; const values = Uint32Array.from({length: 50_000}, (_, index) => index); using serial = UltraLogLogU32.from(values, 8); await using parallel = await ParallelUltraLogLogU32.create({precision: 8, maxValues: values.length, workerCount: 2, workerThreshold: 1}); await parallel.replace(values); const expectedState = serial.state(); const actualState = parallel.state(); if (parallel.lastStrategy !== "workers" || !Number.isFinite(serial.estimate()) || !Number.isFinite(parallel.estimate()) || !expectedState.every((value, index) => value === actualState[index])) throw new Error("unexpected UltraLogLog result");`;
  await Deno.writeTextFile(
    `${temporaryDirectory}/ultra-log-log-smoke.mjs`,
    ultraLogLogExpression,
  );
  await run(
    "node",
    ["--experimental-wasm-modules", "ultra-log-log-smoke.mjs"],
    temporaryDirectory,
  );
  await assertImportFails(metadata.name, temporaryDirectory);

  for (
    const removedSubpath of [
      "bitset",
      "bit-vector",
      "rank-select-bitvector",
      "rank-select-bitmap",
      "roaring-uint32-set",
      "static-mphf-bytes",
    ]
  ) {
    await assertImportFails(`${metadata.name}/${removedSubpath}`, temporaryDirectory);
  }

  for (
    const rejectedDirectory of ["static-mphf-bytes", "packed-uint32-array", "packed-delta-array"]
  ) {
    await assertPathMissing(
      `${temporaryDirectory}/node_modules/${metadata.name}/dist/${rejectedDirectory}`,
    );
  }

  const installedModule = `${temporaryDirectory}/node_modules/${metadata.name}/dist/bitmap/mod.js`;
  const installedBytesModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/bytes/mod.js`;
  const installedSharedBufferModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/shared-buffer/mod.js`;
  const installedUltraLogLogModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/ultra-log-log/mod.js`;
  const installedParallelUltraLogLogModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/ultra-log-log-parallel/mod.js`;
  const installedF32FusionModule =
    `${temporaryDirectory}/node_modules/${metadata.name}/dist/f32-fusion/mod.js`;
  const denoExpression = `import { DenseBitmap } from ${
    JSON.stringify(installedModule)
  }; import { indexOf } from ${
    JSON.stringify(installedBytesModule)
  }; import { SHARED_SYNC_BYTE_LENGTH, SharedBlockPool, SharedBuffer, SharedMutex, SpscRingBufferU32 } from ${
    JSON.stringify(installedSharedBufferModule)
  }; using bits = DenseBitmap.from(128, [1, 10]); using shared = await SharedBuffer.create({maxWorkers: 2}); const mutex = SharedMutex.initialize(shared, 0); mutex.lock(); mutex.unlock(); const pool = SharedBlockPool.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 2); { using block = pool.allocate(256); block.uint8Array()[0] = 1; } const ring = SpscRingBufferU32.initialize(shared, SHARED_SYNC_BYTE_LENGTH * 8, 8); using producer = ring.producer(); using consumer = ring.consumer(); producer.push(42); const counter = shared.uint32Array(SHARED_SYNC_BYTE_LENGTH, 1); Atomics.add(counter, 0, 1); if (bits.countOnes() !== 2 || pool.outstandingBlocks !== 0 || consumer.pop() !== 42 || Atomics.load(counter, 0) !== 1 || indexOf(new Uint8Array([1, 2, 3]), 2) !== 1) throw new Error("unexpected SIMD result");`;
  await run("deno", ["eval", denoExpression], temporaryDirectory);
  const denoFusionExpression = `import { add, constant, createF32FusionCompiler, input } from ${
    JSON.stringify(installedF32FusionModule)
  }; using compiler = createF32FusionCompiler(); const compiled = await compiler.compile(add(input(0), constant(1)), 1); const memory = new WebAssembly.Memory({initial: 1}); new Float32Array(memory.buffer, 0, 1)[0] = 2; const kernel = await compiled.instantiate(memory); kernel.run([0], 16, 1); if (new Float32Array(memory.buffer, 16, 1)[0] !== 3) throw new Error("unexpected f32 fusion result");`;
  await run("deno", ["eval", denoFusionExpression], temporaryDirectory);
  const denoQueueExpression =
    `import { AtomicDenseBitmap, MpmcRingBufferU32, MpmcRingBufferU64, SharedBuffer, SharedSlotMap, ShardedBitmap, StripedHistogram, VersionedBuffer, WorkStealingDequeU32 } from ${
      JSON.stringify(installedSharedBufferModule)
    }; using shared = await SharedBuffer.create(); const queue = MpmcRingBufferU32.initialize(shared, 0, 8); queue.push(42); const handles = MpmcRingBufferU64.initialize(shared, 256, 8); const slots = SharedSlotMap.initialize(shared, 576, {capacity: 1, payloadByteLength: 16}); const bitmap = AtomicDenseBitmap.initialize(shared, 832, 65); bitmap.set(64); const sharded = ShardedBitmap.initialize(shared, 960, {capacity: 65, shardCount: 2}); { using shard = sharded.claimShard(0); shard.set(64); } const histogram = StripedHistogram.initialize(shared, 1280, {bucketCount: 5, stripeCount: 2}); { using stripe = histogram.claimStripe(0); stripe.add(2, 7); } const histogramOutput = new Uint32Array(5); histogram.reduceInto(histogramOutput); const versions = VersionedBuffer.initialize(shared, 1600, 16); { using writer = versions.beginWrite(); writer.bytes[0] = 9; writer.publish(); } using snapshot = versions.acquire(); const deque = WorkStealingDequeU32.initialize(shared, 1920, 8); { using owner = deque.owner(); owner.tryPush(44); } { using slot = slots.allocate(); slot.uint32Array(0, 1)[0] = 43; handles.push(slot.handle); if (handles.pop() !== slot.handle || slots.get(slot.handle)?.uint32Array(0, 1)[0] !== 43) throw new Error("unexpected slot result"); } if (queue.pop() !== 42 || slots.outstandingSlots !== 0 || !bitmap.has(64) || !sharded.reduceOr().has(64) || histogramOutput[2] !== 7 || snapshot.bytes[0] !== 9 || deque.trySteal() !== 44) throw new Error("unexpected shared result");`;
  await run("deno", ["eval", denoQueueExpression], temporaryDirectory);
  const denoUltraLogLogExpression = `import { UltraLogLogU32 } from ${
    JSON.stringify(installedUltraLogLogModule)
  }; import { ParallelUltraLogLogU32 } from ${
    JSON.stringify(installedParallelUltraLogLogModule)
  }; const values = Uint32Array.from({length: 50_000}, (_, index) => index); using serial = UltraLogLogU32.from(values, 8); await using parallel = await ParallelUltraLogLogU32.create({precision: 8, maxValues: values.length, workerCount: 2, workerThreshold: 1}); await parallel.replace(values); const actual = parallel.state(); if (parallel.lastStrategy !== "workers" || !serial.state().every((value, index) => value === actual[index])) throw new Error("unexpected UltraLogLog result");`;
  await run("deno", ["eval", denoUltraLogLogExpression], temporaryDirectory);

  await Deno.writeTextFile(
    `${temporaryDirectory}/consumer.ts`,
    `import { indexOf } from "${metadata.name}/bytes";
import { DenseBitmap } from "${metadata.name}/bitmap";
import { RankSelectBitVector } from "${metadata.name}/rank-select-bit-vector";
import { RoaringBitmap } from "${metadata.name}/roaring-bitmap";
import { AtomicDenseBitmap, MpmcRingBufferU32, MpmcRingBufferU64, SharedBlockPool, SharedBuffer, SharedMutex, SharedSlotMap, ShardedBitmap, SpscRingBufferU32, SpscRingBufferU64, StripedCounter, StripedHistogram, VersionedBuffer, WorkStealingDequeU32 } from "${metadata.name}/shared-buffer";
import { AdaptiveU32Column, SelectionMask } from "${metadata.name}/columnar";
import { BlockedVectorArray } from "${metadata.name}/blocked-vector-array";
import { WaveletMatrixUint16 } from "${metadata.name}/wavelet-matrix-uint16";
import { UltraLogLogU32 } from "${metadata.name}/ultra-log-log";
import { ParallelUltraLogLogU32, type UltraLogLogExecutionStrategy } from "${metadata.name}/ultra-log-log-parallel";
import { add, constant, createF32FusionCompiler, input } from "${metadata.name}/f32-fusion";
using bits = DenseBitmap.from(128, [1, 10]);
using ranked = RankSelectBitVector.from(128, [1, 10]);
using roaring = RoaringBitmap.from([1, 10]);
using fusionCompiler = createF32FusionCompiler({ maxModules: 2 });
const fusionPlan = await fusionCompiler.compile(add(input(0), constant(1)), 1);
const fusionInputCount: number = fusionPlan.inputCount;
using shared = await SharedBuffer.create({ maxWorkers: 2 });
const sharedMutex = SharedMutex.initialize(shared, 0);
sharedMutex.lock();
sharedMutex.unlock();
const sharedPool = SharedBlockPool.initialize(shared, 128);
{
  using block = sharedPool.allocate(256);
  block.uint8Array()[0] = 1;
}
const ring = SpscRingBufferU32.initialize(shared, 512, 8);
using producer = ring.producer();
using consumer = ring.consumer();
producer.push(42);
const received: number = consumer.pop();
const mpmc = MpmcRingBufferU32.initialize(shared, 768, 8);
mpmc.push(43);
const receivedMpmc: number = mpmc.pop();
const slots = SharedSlotMap.initialize(shared, 1024, { capacity: 1, payloadByteLength: 16 });
using slot = slots.allocate();
slot.uint32Array(0, 1)[0] = 44;
const slotHandle: bigint = slot.handle;
const spscU64 = SpscRingBufferU64.initialize(shared, 1280, 8);
using producerU64 = spscU64.producer();
using consumerU64 = spscU64.consumer();
producerU64.push(slotHandle);
const receivedSpscU64: bigint = consumerU64.pop();
const mpmcU64 = MpmcRingBufferU64.initialize(shared, 1536, 8);
mpmcU64.push(slotHandle);
const receivedMpmcU64: bigint = mpmcU64.pop();
const atomicBitmap = AtomicDenseBitmap.initialize(shared, 1856, 65);
atomicBitmap.set(64);
const atomicBit: boolean = atomicBitmap.has(64);
const shardedBitmap = ShardedBitmap.initialize(shared, 1984, { capacity: 65, shardCount: 2 });
{
  using shard = shardedBitmap.claimShard(0);
  shard.set(64);
}
const reducedBit: boolean = shardedBitmap.reduceOr().has(64);
const stripedCounter = StripedCounter.initialize(shared, 2304, 2);
{
  using stripe = stripedCounter.claimStripe(0);
  stripe.increment();
}
const stripedCount: number = stripedCounter.sum();
const stripedHistogram = StripedHistogram.initialize(shared, 2624, { bucketCount: 4, stripeCount: 2 });
const histogramCounts = new Uint32Array(4);
stripedHistogram.reduceInto(histogramCounts);
const versionedBuffer = VersionedBuffer.initialize(shared, 2944, 16);
{
  using writer = versionedBuffer.beginWrite();
  writer.bytes[0] = 1;
  writer.publish();
}
using versionedSnapshot = versionedBuffer.acquire();
const snapshotGeneration: number = versionedSnapshot.generation;
const workDeque = WorkStealingDequeU32.initialize(shared, 3264, 8);
{
  using owner = workDeque.owner();
  owner.tryPush(1);
}
const stolenTask: number | undefined = workDeque.trySteal();
using column = AdaptiveU32Column.from(new Uint32Array([0xffff_ffff, 1, 2]));
using selected = new SelectionMask(3);
using vectors = BlockedVectorArray.from(new Float32Array([0, 1, 1, 0]), 2, 2);
using wavelet = WaveletMatrixUint16.from(new Uint16Array([3, 1, 2, 1]));
using ultraLogLog = UltraLogLogU32.from(new Uint32Array([1, 2, 3]), 8);
await using parallelUltraLogLog = await ParallelUltraLogLogU32.create({
  precision: 8,
  maxValues: 3,
  workerCount: 2,
});
await parallelUltraLogLog.replace(new Uint32Array([1, 2, 3]));
column.scanLt(3, selected);
const nearestIds = new Uint32Array(1);
const nearestDistances = new Float32Array(1);
vectors.topKInto(new Float32Array([0, 0]), nearestIds, nearestDistances);
const count: number = bits.countOnes();
const rank: number = ranked.rank1(128);
const roaringCount: number = roaring.size;
const sharedWorkers: number = shared.activeWorkers;
const selectedCount: number = selected.countOnes();
const vectorCount: number = vectors.length;
const byteIndex: number = indexOf(new Uint8Array([1, 2, 3]), 2);
const waveletRank: number = wavelet.rank(1, wavelet.length);
const nearestId: number = nearestIds[0]!;
const cardinality: number = ultraLogLog.estimate();
const parallelStrategy: UltraLogLogExecutionStrategy | null = parallelUltraLogLog.lastStrategy;
void count;
void rank;
void roaringCount;
void sharedWorkers;
void selectedCount;
void vectorCount;
void byteIndex;
void waveletRank;
void nearestId;
void received;
void receivedMpmc;
void slotHandle;
void receivedSpscU64;
void receivedMpmcU64;
void atomicBit;
void reducedBit;
void stripedCount;
void histogramCounts;
void snapshotGeneration;
void stolenTask;
void cardinality;
void parallelStrategy;
void fusionInputCount;
`,
  );
  await run(
    `${Deno.cwd()}/node_modules/.bin/tsc`,
    [
      "--noEmit",
      "--strict",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "consumer.ts",
    ],
    temporaryDirectory,
  );

  await Deno.writeTextFile(
    `${temporaryDirectory}/index.html`,
    '<script type="module" src="/vite-consumer.ts"></script>\n',
  );
  await Deno.writeTextFile(
    `${temporaryDirectory}/vite-consumer.ts`,
    `import { indexOf } from "${metadata.name}/bytes";\n` +
      `import { add, constant, createF32FusionCompiler, input } from "${metadata.name}/f32-fusion";\n` +
      `using compiler = createF32FusionCompiler();\n` +
      `const compiled = await compiler.compile(add(input(0), constant(1)), 1);\n` +
      `const memory = new WebAssembly.Memory({ initial: 1 });\n` +
      `new Float32Array(memory.buffer, 0, 1)[0] = 2;\n` +
      `const kernel = await compiled.instantiate(memory);\n` +
      `kernel.run([0], 16, 1);\n` +
      `document.body.textContent = String(indexOf(new Uint8Array([1, 2, 3]), 2) + new Float32Array(memory.buffer, 16, 1)[0]);\n`,
  );
  await Deno.writeTextFile(
    `${temporaryDirectory}/vite.config.ts`,
    "export default { build: { assetsInlineLimit: 0 } };\n",
  );
  await run(
    `${Deno.cwd()}/node_modules/.bin/vite`,
    ["build"],
    temporaryDirectory,
  );
  const viteAssets = Array.from(
    Deno.readDirSync(`${temporaryDirectory}/dist/assets`),
  );
  const wasmAssets = viteAssets.filter((entry) => entry.isFile && entry.name.endsWith(".wasm"));
  if (wasmAssets.length !== 1) {
    throw new Error(`expected one Vite Wasm asset, got ${wasmAssets.length}`);
  }

  console.log(
    `${metadata.name}@${metadata.version} package smoke test passed in Node, Deno, TypeScript, and Vite`,
  );
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`);
  }
  return stdout;
}

async function assertImportFails(specifier: string, cwd: string): Promise<void> {
  const result = await new Deno.Command("node", {
    args: ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) throw new Error(`removed package subpath still resolves: ${specifier}`);
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(`rejected implementation was included in the package: ${path}`);
}
