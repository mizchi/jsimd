import {
  collectPixelBlockChangedEvents,
  decodePixelBlockGpuEvents,
  PIXEL_BLOCK_GPU_EVENT_HEADER_WORDS,
  PIXEL_BLOCK_GPU_EVENT_KIND,
  PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS,
} from "./pixel_block_gpu_events.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("GPU changed-block event reference follows staggered ownership and bounds output", () => {
  const width = 4;
  const height = 4;
  const before = new Uint32Array(width * height);
  const after = before.slice();
  after[0] = 2;
  after[3] = 3;

  const result = collectPixelBlockChangedEvents(before, after, width, height, 0, 1);

  assertEquals(result.total, 2);
  assertEquals(result.dropped, 1);
  assertEquals(Array.from(result.records), [PIXEL_BLOCK_GPU_EVENT_KIND.changed, 0, 1, 0]);
});

Deno.test("GPU event readback decoder preserves header counters and fixed-width records", () => {
  const capacity = 2;
  const words = new Uint32Array(
    PIXEL_BLOCK_GPU_EVENT_HEADER_WORDS + capacity * PIXEL_BLOCK_GPU_EVENT_RECORD_WORDS,
  );
  words.set([3, 1, 7, 0]);
  words.set([PIXEL_BLOCK_GPU_EVENT_KIND.changed, 5, 0b0110, 7], 4);
  words.set([PIXEL_BLOCK_GPU_EVENT_KIND.changed, 11, 0b1001, 7], 8);

  const decoded = decodePixelBlockGpuEvents(words, capacity);

  assertEquals(decoded.total, 3);
  assertEquals(decoded.dropped, 1);
  assertEquals(decoded.tick, 7);
  assertEquals(Array.from(decoded.records), Array.from(words.slice(4)));
});
