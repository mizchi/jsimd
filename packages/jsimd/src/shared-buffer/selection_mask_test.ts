import { SharedBuffer, SharedSelectionMask } from "./mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(operation: () => unknown, constructor: typeof Error, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(message);
}

Deno.test("SharedSelectionMask publishes one attachable generation for downstream Workers", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using peer = await SharedBuffer.attach(owner.memory);
  const mask = SharedSelectionMask.initialize(owner, 0, 131);
  const attached = SharedSelectionMask.attach(peer, 0);

  assert(mask.byteLength % 64 === 0, "cache-line-sized layout");
  assert(mask.dataByteOffset % 16 === 0, "SIMD-aligned words");
  assert(mask.wordCount === 5 && mask.paddedWords === 8, "word layout");

  let generation = 0;
  {
    using writer = mask.claimWriter();
    writer.clearAll();
    writer.set(0);
    writer.set(63);
    writer.set(130);
    generation = writer.publish();
  }

  const view = attached.read(generation);
  assert(view.has(0) && view.has(63) && view.has(130), "published bits");
  assert(!view.has(1) && view.countOnes() === 3, "published count");
  assert(view.dataByteOffset === mask.dataByteOffset, "shared kernel ABI offset");
});

Deno.test("SharedSelectionMask enforces writer ownership and generation lifetime", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using peer = await SharedBuffer.attach(owner.memory);
  const mask = SharedSelectionMask.initialize(owner, 0, 65);
  const attached = SharedSelectionMask.attach(peer, 0);

  const writer = mask.claimWriter();
  assertThrows(() => attached.claimWriter(), RangeError, "writer must be exclusive");
  writer.fillAll();
  const firstGeneration = writer.publish();
  const first = attached.read(firstGeneration);
  assert(first.countOnes() === 65, "tail bits remain clear");

  writer.clearAll();
  writer.set(32);
  const secondGeneration = writer.publish();
  assertThrows(() => first.has(0), Error, "old view becomes stale");
  assert(attached.read(secondGeneration).has(32), "new generation is visible");
  writer[Symbol.dispose]();
});
