import { LIFE_COMMAND, LifeSharedBoard } from "./life_shared.ts";

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
