import { SharedBuffer, VersionedBuffer } from "./mod.ts";

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

Deno.test("VersionedBuffer publishes immutable snapshots and protects old slots", async () => {
  using owner = await SharedBuffer.create({ maxWorkers: 2 });
  using attached = await SharedBuffer.attach(owner.memory);
  const cell = VersionedBuffer.initialize(owner, 0, 32);
  const peer = VersionedBuffer.attach(attached, 0);
  assert(cell.slotStride === 64 && cell.byteCapacity === 32, "layout");

  const initial = cell.acquire();
  assert(initial.generation === 0 && initial.bytes[0] === 0, "initial snapshot");
  {
    using writer = peer.beginWrite();
    writer.bytes.fill(0);
    writer.bytes[0] = 17;
    writer.bytes[31] = 99;
    assert(writer.publish() === 1, "first generation");
  }
  const first = cell.acquire();
  assert(first.generation === 1 && first.bytes[0] === 17 && first.bytes[31] === 99, "published");
  assert(initial.bytes[0] === 0, "old snapshot stays immutable");
  assert(cell.tryBeginWrite() === undefined, "held old slot blocks reuse");

  initial[Symbol.dispose]();
  {
    using writer = cell.beginWrite();
    writer.bytes.fill(23);
    assert(writer.publish() === 2, "second generation");
  }
  const second = peer.acquire();
  assert(second.generation === 2 && second.bytes[0] === 23, "second publication");
  assert(first.bytes[0] === 17, "first snapshot stays immutable");
  assert(peer.tryBeginWrite() === undefined, "first snapshot blocks its slot reuse");
  first[Symbol.dispose]();
  second[Symbol.dispose]();
});

Deno.test("VersionedBuffer discarded writers do not publish partial data", async () => {
  using shared = await SharedBuffer.create();
  const cell = VersionedBuffer.initialize(shared, 0, 16);
  {
    using writer = cell.beginWrite();
    writer.bytes.fill(7);
  }
  using snapshot = cell.acquire();
  assert(snapshot.generation === 0, "generation unchanged");
  assert(snapshot.bytes.every((value) => value === 0), "inactive writes remain unpublished");
});

Deno.test("VersionedBuffer validates writers, snapshots, layouts, and lifetimes", async () => {
  const shared = await SharedBuffer.create();
  assertThrows(() => VersionedBuffer.initialize(shared, 4, 16), RangeError, "alignment");
  assertThrows(() => VersionedBuffer.initialize(shared, 0, 0), RangeError, "positive capacity");
  const cell = VersionedBuffer.initialize(shared, 0, 65);
  assert(cell.slotStride === 128, "slot cache-line rounding");
  const writer = cell.beginWrite();
  assertThrows(() => cell.beginWrite(), RangeError, "exclusive writer");
  writer[Symbol.dispose]();
  const snapshot = cell.acquire();
  snapshot[Symbol.dispose]();
  assertThrows(() => snapshot.bytes, Error, "disposed snapshot");
  shared[Symbol.dispose]();
  assertThrows(() => cell.acquire(), Error, "disposed backing lease");
});
