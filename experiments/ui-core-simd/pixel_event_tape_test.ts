import { PIXEL_EVENT_KIND, PIXEL_EVENT_RECORD_WORDS, PixelEventTape } from "./pixel_event_tape.ts";

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

Deno.test("PixelEventTape preserves fixed-width reaction events across ring wrap", () => {
  const writer = PixelEventTape.create(4);
  const reader = PixelEventTape.attach(writer.buffer);
  const first = new Int32Array(2 * PIXEL_EVENT_RECORD_WORDS);
  const second = new Int32Array(4 * PIXEL_EVENT_RECORD_WORDS);

  writer.push(PIXEL_EVENT_KIND.vaporized, 7, 0x0000_8003, 0x0000_8004);
  writer.push(PIXEL_EVENT_KIND.condensed, 8, 0x0000_6004, 0x0000_6003);
  writer.push(PIXEL_EVENT_KIND.vaporized, 9, 3, 4);
  assertEquals(reader.drainInto(first), 2);
  writer.push(PIXEL_EVENT_KIND.condensed, 10, 4, 3);
  writer.push(PIXEL_EVENT_KIND.vaporized, 11, 3, 4);

  assertEquals(reader.drainInto(second), 3);
  assertEquals(Array.from(second.slice(0, 12)), [
    PIXEL_EVENT_KIND.vaporized,
    9,
    3,
    4,
    PIXEL_EVENT_KIND.condensed,
    10,
    4,
    3,
    PIXEL_EVENT_KIND.vaporized,
    11,
    3,
    4,
  ]);
});

Deno.test("PixelEventTape reports overflow without overwriting unread events", () => {
  const tape = PixelEventTape.create(2);
  assertEquals(tape.push(PIXEL_EVENT_KIND.vaporized, 1, 3, 4), true);
  assertEquals(tape.push(PIXEL_EVENT_KIND.condensed, 2, 4, 3), true);
  assertEquals(tape.push(PIXEL_EVENT_KIND.vaporized, 3, 3, 4), false);
  tape.recordDropped(3);
  assertEquals(tape.droppedCount, 4);
  assertThrows(() => PixelEventTape.create(3), RangeError);
});

Deno.test("PixelEventTape publishes one timestamp per compact event batch", () => {
  const writer = PixelEventTape.create(4);
  const reader = PixelEventTape.attach(writer.buffer);
  writer.markPublished(0xffff_ff00);
  writer.push(PIXEL_EVENT_KIND.vaporized, 4, 3, 4);

  assertEquals(reader.publishedMicros, 0xffff_ff00);
  assertThrows(() => writer.markPublished(-1), RangeError);
});
