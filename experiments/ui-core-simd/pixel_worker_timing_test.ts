import { inputToPresentMicros } from "./pixel_worker_timing.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

Deno.test("worker timing compares clocks through the main time origin", () => {
  assertEquals(inputToPresentMicros(1_000_000, 1_000_005, 10, 12_000), 3_000);
});

Deno.test("worker timing preserves short latency across the u32 timestamp wrap", () => {
  assertEquals(inputToPresentMicros(0, 4_294_960, 10, 4_294_966_000), 4_000);
});
