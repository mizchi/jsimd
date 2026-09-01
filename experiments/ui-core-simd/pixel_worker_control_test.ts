import {
  PIXEL_WORKER_STATS_WORDS,
  PixelWorkerControl,
} from "./pixel_worker_control.ts";

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

Deno.test("PixelWorkerControl publishes consistent worker statistics", () => {
  const writer = PixelWorkerControl.create(1_024, 640);
  const reader = PixelWorkerControl.attach(writer.buffer);
  const stats = new Int32Array(PIXEL_WORKER_STATS_WORDS);

  writer.publish(7, 1_234, 567, 19, 765_432);

  assertEquals(reader.tryStatsInto(stats), true);
  assertEquals(Array.from(stats), [7, 1_234, 567, 19, 1, 765_432, 1, 60]);
});

Deno.test("PixelWorkerControl shares viewport, brush, running state, and rate", () => {
  const main = PixelWorkerControl.create(512, 320);
  const worker = PixelWorkerControl.attach(main.buffer);

  main.setViewportFixed(64, 128, 32_768, 20_480);
  main.brushMaterial = 3;
  main.running = false;
  main.setRate(144);

  assertEquals(worker.viewport, {
    leftFixed: 64,
    topFixed: 128,
    widthFixed: 32_768,
    heightFixed: 20_480,
  });
  assertEquals(worker.brushMaterial, 3);
  assertEquals(worker.running, false);
  assertEquals(worker.rate, 120);
});

Deno.test("PixelWorkerControl validates its ABI and output storage", () => {
  const control = PixelWorkerControl.create(64, 40);
  assertEquals(control.buffer.byteLength, 80);
  assertThrows(
    () => control.tryStatsInto(new Int32Array(PIXEL_WORKER_STATS_WORDS - 1)),
    RangeError,
  );
  assertThrows(() => {
    control.brushMaterial = 4;
  }, RangeError);
  assertThrows(() => PixelWorkerControl.attach(control.buffer.slice(0, 76)), TypeError);
  const malformed = control.buffer.slice(0);
  new Int32Array(malformed)[0] = 0;
  assertThrows(() => PixelWorkerControl.attach(malformed), TypeError);
});
