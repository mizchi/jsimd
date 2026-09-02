import {
  decodePixelGpuEvents,
  PIXEL_GPU_EVENT_HEADER_WORDS,
  PIXEL_GPU_EVENT_RECORD_WORDS,
  pixelGpuEventBytes,
} from "./pixel_gpu_event_buffer.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("GPU event buffer decodes a bounded semantic record prefix", () => {
  const capacity = 2;
  const words = new Uint32Array(
    PIXEL_GPU_EVENT_HEADER_WORDS + capacity * PIXEL_GPU_EVENT_RECORD_WORDS,
  );
  words.set([3, 1, 9, 0]);
  words.set([1, 17, 0x0080_0003, 0x008f_0004], PIXEL_GPU_EVENT_HEADER_WORDS);
  words.set([2, 23, 0x0040_0004, 0x0048_0003], PIXEL_GPU_EVENT_HEADER_WORDS + 4);

  const result = decodePixelGpuEvents(words, capacity);

  assertEquals(pixelGpuEventBytes(capacity), words.byteLength);
  assertEquals(result.total, 3);
  assertEquals(result.dropped, 1);
  assertEquals(result.tick, 9);
  assertEquals(Array.from(result.records), Array.from(words.slice(4)));
});

Deno.test("GPU event buffer validates capacity and exact readback shape", () => {
  let failures = 0;
  for (
    const operation of [
      () => pixelGpuEventBytes(0),
      () => decodePixelGpuEvents(new Uint32Array(4), 2),
    ]
  ) {
    try {
      operation();
    } catch (error) {
      if (error instanceof RangeError) failures++;
    }
  }
  assertEquals(failures, 2);
});
