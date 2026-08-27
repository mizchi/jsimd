import {
  AtomicDenseBitmap,
  MpmcRingBufferU32,
  MpmcRingBufferU64,
  ShardedBitmap,
  SHARED_SYNC_BYTE_LENGTH,
  SharedBlockPool,
  SharedBuffer,
  SharedMutex,
  SharedSlotMap,
  SharedWaitGroup,
  SpscRingBufferU32,
  StripedHistogram,
  VersionedBuffer,
  WorkStealingDequeU32,
} from "../../src/shared-buffer/mod.ts";

async function main(): Promise<void> {
  using shared = await SharedBuffer.create({ maxWorkers: 2 });
  const mutexOffset = 0;
  const waitGroupOffset = SHARED_SYNC_BYTE_LENGTH;
  const counterOffset = SHARED_SYNC_BYTE_LENGTH * 2;
  const ringOffset = SHARED_SYNC_BYTE_LENGTH * 3;
  const mpmcOffset = ringOffset + SpscRingBufferU32.byteLengthFor(8);
  const slotMapOffset = mpmcOffset + MpmcRingBufferU32.byteLengthFor(8);
  const u64QueueOffset = slotMapOffset +
    SharedSlotMap.byteLengthFor({ capacity: 8, payloadByteLength: 16 });
  const bitmapOffset = u64QueueOffset + MpmcRingBufferU64.byteLengthFor(8);
  const shardedBitmapOffset = bitmapOffset + AtomicDenseBitmap.byteLengthFor(128);
  const histogramOffset = shardedBitmapOffset +
    ShardedBitmap.byteLengthFor({ capacity: 128, shardCount: 1 });
  const versionedBufferOffset = histogramOffset +
    StripedHistogram.byteLengthFor({ bucketCount: 8, stripeCount: 1 });
  const dequeOffset = versionedBufferOffset + VersionedBuffer.byteLengthFor(16);
  const poolOffset = dequeOffset + WorkStealingDequeU32.byteLengthFor(8);
  SharedMutex.initialize(shared, mutexOffset);
  const waitGroup = SharedWaitGroup.initialize(shared, waitGroupOffset, 1);
  const ring = SpscRingBufferU32.initialize(shared, ringOffset, 8);
  using consumer = ring.consumer();
  const mpmc = MpmcRingBufferU32.initialize(shared, mpmcOffset, 8);
  const slots = SharedSlotMap.initialize(shared, slotMapOffset, {
    capacity: 8,
    payloadByteLength: 16,
  });
  using slot = slots.allocate();
  slot.uint32Array(0, 2).set([0x534c_4f54, 0]);
  const handles = MpmcRingBufferU64.initialize(shared, u64QueueOffset, 8);
  handles.push(slot.handle);
  const bitmap = AtomicDenseBitmap.initialize(shared, bitmapOffset, 128);
  const shardedBitmap = ShardedBitmap.initialize(shared, shardedBitmapOffset, {
    capacity: 128,
    shardCount: 1,
  });
  const histogram = StripedHistogram.initialize(shared, histogramOffset, {
    bucketCount: 8,
    stripeCount: 1,
  });
  const versions = VersionedBuffer.initialize(shared, versionedBufferOffset, 16);
  const deque = WorkStealingDequeU32.initialize(shared, dequeOffset, 8);
  using dequeOwner = deque.owner();
  dequeOwner.tryPush(0x5753_4451);
  SharedBlockPool.initialize(shared, poolOffset);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  try {
    const result = new Promise<number>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<number>) => resolve(event.data);
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
    });
    worker.postMessage({
      memory: shared.memory,
      mutexOffset,
      waitGroupOffset,
      counterOffset,
      ringOffset,
      mpmcOffset,
      slotMapOffset,
      u64QueueOffset,
      bitmapOffset,
      shardedBitmapOffset,
      histogramOffset,
      versionedBufferOffset,
      dequeOffset,
      poolOffset,
    });
    await waitGroup.waitAsync();
    if (await consumer.popAsync() !== 0x4a53_494d) throw new Error("unexpected SPSC value");
    if (await mpmc.popAsync() !== 0x4d50_4d43) throw new Error("unexpected MPMC value");
    if (await handles.popAsync() !== slot.handle) throw new Error("unexpected u64 handle");
    if (!bitmap.has(37)) throw new Error("unexpected atomic bitmap value");
    if (!shardedBitmap.reduceOr().has(55)) throw new Error("unexpected sharded bitmap value");
    const histogramOutput = new Uint32Array(histogram.bucketCount);
    histogram.reduceInto(histogramOutput);
    if (histogramOutput[3] !== 7) throw new Error("unexpected striped histogram value");
    using snapshot = versions.acquire();
    if (snapshot.generation !== 1 || snapshot.bytes[0] !== 77) {
      throw new Error("unexpected versioned buffer value");
    }
    if (slot.uint32Array(0, 2)[1] !== 1) throw new Error("unexpected SharedSlotMap value");
    const value = await result;
    document.body.textContent = String(value);
    await fetch("/__jsimd_result", { method: "POST", body: String(value) });
  } finally {
    worker.terminate();
  }
}

void main();
