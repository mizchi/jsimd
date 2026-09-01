import { summarizeSamples } from "./benchmark_stats.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("benchmark summary reports median and p95 without mutating samples", () => {
  const samples = [9, 1, 5, 3, 7, 11, 13, 15, 17, 19, 100];
  assertEquals(summarizeSamples(samples), { median: 11, p95: 100 });
  assertEquals(samples, [9, 1, 5, 3, 7, 11, 13, 15, 17, 19, 100]);
});
