import {
  parsePixelOccupancy,
  parsePixelRegion,
  parsePixelRuntime,
  parsePixelWidth,
} from "./pixel_options.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("pixel benchmark parses bounded scenario options", () => {
  assertEquals(parsePixelRuntime(null), "worker-reaction-simd");
  assertEquals(parsePixelRuntime("cpu"), "cpu");
  assertEquals(parsePixelRuntime("block"), "block");
  assertEquals(parsePixelRuntime("block-active"), "block-active");
  assertEquals(parsePixelRuntime("block-simd"), "block-simd");
  assertEquals(parsePixelRuntime("block-active-simd"), "block-active-simd");
  assertEquals(parsePixelRuntime("active"), "active");
  assertEquals(parsePixelRuntime("worker"), "worker");
  assertEquals(parsePixelRuntime("worker-simd"), "worker-simd");
  assertEquals(parsePixelRuntime("worker-reaction-simd"), "worker-reaction-simd");
  assertEquals(parsePixelRuntime("block-webgpu"), "block-webgpu");
  assertEquals(parsePixelRuntime("webgpu"), "webgpu");
  assertEquals(parsePixelWidth("1024"), 1_024);
  assertEquals(parsePixelOccupancy("5"), 0.05);
  assertEquals(parsePixelOccupancy("75"), 0.75);
  assertEquals(parsePixelRegion(null), "full");
  assertEquals(parsePixelRegion("spot"), "spot");
});

Deno.test("pixel benchmark rejects unknown options", () => {
  let errors = 0;
  for (
    const invoke of [
      () => parsePixelRuntime("threaded"),
      () => parsePixelWidth("4096"),
      () => parsePixelOccupancy("20"),
      () => parsePixelRegion("left"),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) errors++;
    }
  }
  assertEquals(errors, 4);
});
