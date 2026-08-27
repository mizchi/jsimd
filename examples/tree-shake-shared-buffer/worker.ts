import {
  AtomicDenseBitmap,
  MpmcRingBufferU32,
  MpmcRingBufferU64,
  ShardedBitmap,
  SharedBlockPool,
  SharedBuffer,
  SharedMutex,
  SharedSlotMap,
  SharedWaitGroup,
  SpscRingBufferU32,
  StripedHistogram,
  VersionedBuffer,
  WorkStealingDequeU32,
} from "../../packages/jsimd/src/shared-buffer/mod.ts";

self.onmessage = async (
  event: MessageEvent<{
    memory: WebAssembly.Memory;
    mutexOffset: number;
    waitGroupOffset: number;
    counterOffset: number;
    ringOffset: number;
    mpmcOffset: number;
    slotMapOffset: number;
    u64QueueOffset: number;
    bitmapOffset: number;
    shardedBitmapOffset: number;
    histogramOffset: number;
    versionedBufferOffset: number;
    dequeOffset: number;
    poolOffset: number;
  }>,
) => {
  using shared = await SharedBuffer.attach(event.data.memory);
  const mutex = SharedMutex.attach(shared, event.data.mutexOffset);
  const waitGroup = SharedWaitGroup.attach(shared, event.data.waitGroupOffset);
  const counter = shared.uint32Array(event.data.counterOffset, 1);
  const ring = SpscRingBufferU32.attach(shared, event.data.ringOffset);
  using producer = ring.producer();
  const mpmc = MpmcRingBufferU32.attach(shared, event.data.mpmcOffset);
  const slots = SharedSlotMap.attach(shared, event.data.slotMapOffset);
  const handles = MpmcRingBufferU64.attach(shared, event.data.u64QueueOffset);
  const handle = handles.pop();
  const bitmap = AtomicDenseBitmap.attach(shared, event.data.bitmapOffset);
  if (bitmap.testAndSet(37)) throw new Error("atomic bitmap bit was already set");
  const shardedBitmap = ShardedBitmap.attach(shared, event.data.shardedBitmapOffset);
  {
    using shard = shardedBitmap.claimShard(0);
    shard.set(55);
  }
  const histogram = StripedHistogram.attach(shared, event.data.histogramOffset);
  {
    using stripe = histogram.claimStripe(0);
    stripe.add(3, 7);
  }
  const versions = VersionedBuffer.attach(shared, event.data.versionedBufferOffset);
  {
    using writer = versions.beginWrite();
    writer.bytes.fill(0);
    writer.bytes[0] = 77;
    writer.publish();
  }
  const deque = WorkStealingDequeU32.attach(shared, event.data.dequeOffset);
  if (deque.trySteal() !== 0x5753_4451) throw new Error("unexpected stolen task");
  const slot = slots.get(handle);
  if (slot === undefined || slot.uint32Array(0, 2)[0] !== 0x534c_4f54) {
    throw new Error("unexpected SharedSlotMap handle");
  }
  slot.uint32Array(0, 2)[1] = 1;
  handles.push(handle);
  const pool = SharedBlockPool.attach(shared, event.data.poolOffset);
  {
    using block = pool.allocate(256);
    block.uint32Array(0, 1)[0] = 0x4a53_494d;
  }
  mutex.lock();
  counter[0]++;
  mutex.unlock();
  producer.push(0x4a53_494d);
  mpmc.push(0x4d50_4d43);
  waitGroup.done();
  self.postMessage(counter[0]);
};
