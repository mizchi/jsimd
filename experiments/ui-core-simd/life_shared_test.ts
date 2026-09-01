import { LIFE_COMMAND, LIFE_STATS_WORDS, LifeSharedBoard } from "./life_shared.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

Deno.test("LifeSharedBoard publishes a complete back buffer", () => {
  const writer = LifeSharedBoard.create(4, 3);
  const reader = LifeSharedBoard.attach(writer.buffer);
  const write = writer.beginWrite();
  write.cells.set([1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  writer.publish(write.index, 4, 275);
  const snapshot = new Uint8Array(12);

  assertEquals(reader.trySnapshotInto(snapshot), true);
  assertEquals(Array.from(snapshot), Array.from(write.cells));
  assertEquals(reader.generation, 1);
  assertEquals(reader.liveCount, 4);
  assertEquals(reader.stepMicros, 275);
});

Deno.test("LifeSharedBoard associates an input timestamp with its published frame", () => {
  const writer = LifeSharedBoard.create(4, 3);
  const reader = LifeSharedBoard.attach(writer.buffer);
  const first = writer.beginWrite();
  writer.publish(first.index, 1, 25, 123_456);

  assertEquals(reader.inputSequence, 1);
  assertEquals(reader.inputTimeMicros, 123_456);

  const simulation = writer.beginWrite();
  writer.publish(simulation.index, 1, 20);
  assertEquals(reader.inputSequence, 1);
  assertEquals(reader.inputTimeMicros, 123_456);
});

Deno.test("LifeSharedBoard snapshots metadata without copying cells", () => {
  const board = LifeSharedBoard.create(4, 3);
  const stats = new Int32Array(LIFE_STATS_WORDS);
  const write = board.beginWrite();
  assertEquals(board.tryStatsInto(stats), false);
  board.publish(write.index, 5, 42, 123_456, 77);

  assertEquals(board.tryStatsInto(stats), true);
  assertEquals(Array.from(stats), [1, 5, 42, 1, 123_456, 1, 77]);
  assertThrows(() => board.tryStatsInto(new Int32Array(LIFE_STATS_WORDS - 1)), RangeError);
});

Deno.test("LifeSharedBoard can omit cell snapshots for an offscreen renderer", () => {
  const writer = LifeSharedBoard.create(1_024, 640, { cellSnapshots: false });
  const reader = LifeSharedBoard.attach(writer.buffer);

  assertEquals(writer.buffer.byteLength, 80);
  assertEquals(reader.hasCellSnapshots, false);
  const write = writer.beginWrite();
  assertEquals(write.cells.length, 0);
  writer.publish(write.index, 12_345, 98, 654_321, 1_234);
  const stats = new Int32Array(LIFE_STATS_WORDS);
  assertEquals(reader.tryStatsInto(stats), true);
  assertEquals(Array.from(stats), [1, 12_345, 98, 1, 654_321, 1, 1_234]);
  assertThrows(() => reader.trySnapshotInto(new Uint8Array(writer.cellCount)), Error);
});

Deno.test("LifeSharedBoard rejects snapshots while a write is active", () => {
  const board = LifeSharedBoard.create(2, 2);
  board.beginWrite();

  assertEquals(board.trySnapshotInto(new Uint8Array(4)), false);
});

Deno.test("LifeSharedBoard shares viewport, rate, and commands", () => {
  const main = LifeSharedBoard.create(8, 6);
  const worker = LifeSharedBoard.attach(main.buffer);
  main.setViewportFixed(64, 128, 6400, 3200);
  main.setRate(45);
  const sequence = main.issueCommand(LIFE_COMMAND.randomize);

  assertEquals(worker.viewport, {
    leftFixed: 64,
    topFixed: 128,
    widthFixed: 6400,
    heightFixed: 3200,
  });
  assertEquals(worker.rate, 45);
  assertEquals(worker.commandSequence, sequence);
  assertEquals(worker.command, LIFE_COMMAND.randomize);
});

Deno.test("LifeSharedBoard validates ABI and snapshot size", () => {
  const board = LifeSharedBoard.create(4, 4);
  assertThrows(() => board.trySnapshotInto(new Uint8Array(15)), RangeError);
  const malformed = board.buffer.slice(0);
  new Int32Array(malformed)[0] = 0;
  assertThrows(() => LifeSharedBoard.attach(malformed), TypeError);
});
