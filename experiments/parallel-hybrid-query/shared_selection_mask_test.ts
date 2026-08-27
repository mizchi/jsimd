import { SharedBuffer } from "../../src/shared-buffer/mod.ts";
import { SharedSelectionMask } from "./shared_selection_mask.ts";

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

Deno.test("SharedSelectionMask publishes an attachable generation without materializing row IDs", async () => {
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
  assert(view.paddedWords === mask.paddedWords, "shared kernel ABI width");
});

Deno.test("SharedSelectionMask keeps writer ownership exclusive and rejects stale generations", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using peer = await SharedBuffer.attach(owner.memory);
  const mask = SharedSelectionMask.initialize(owner, 0, 65);
  const attached = SharedSelectionMask.attach(peer, 0);

  const writer = mask.claimWriter();
  assertThrows(() => attached.claimWriter(), RangeError, "writer must be exclusive");
  writer.fillAll();
  const firstGeneration = writer.publish();
  const first = attached.read(firstGeneration);
  assert(first.countOnes() === 65, "tail bits must remain clear");

  writer.clearAll();
  writer.set(32);
  const secondGeneration = writer.publish();
  assert(secondGeneration !== firstGeneration, "generation advances");
  assertThrows(() => first.has(0), Error, "old view must become stale");
  assert(attached.read(secondGeneration).has(32), "new view");

  writer.clearAll();
  writer[Symbol.dispose]();
  using reused = attached.claimWriter();
  const recoveredGeneration = reused.publish();
  assert(
    recoveredGeneration !== firstGeneration && recoveredGeneration !== secondGeneration,
    "released dirty ownership preserves monotonic generations",
  );
});

Deno.test("SharedSelectionMask validates shape, bounds, and backing lifetime", async () => {
  using shared = await SharedBuffer.create();
  assertThrows(() => SharedSelectionMask.initialize(shared, 1, 32), RangeError, "alignment");
  assertThrows(() => SharedSelectionMask.byteLengthFor(-1), RangeError, "capacity");

  const mask = SharedSelectionMask.initialize(shared, 0, 33);
  using writer = mask.claimWriter();
  assertThrows(() => writer.set(33), RangeError, "bit bounds");
  assertThrows(() => mask.read(1), Error, "unpublished generation");
  const generation = writer.publish();
  const view = mask.read(generation);
  assertThrows(() => view.has(33), RangeError, "read bounds");

  shared[Symbol.dispose]();
  assertThrows(() => view.has(0), Error, "backing lifetime");
});
