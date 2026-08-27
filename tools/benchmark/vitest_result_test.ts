import { createVitestBenchmarkResult } from "./vitest_result.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertThrows(operation: () => void, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof RangeError && error.message.includes(message)) return;
    throw error;
  }
  throw new Error("expected operation to throw");
}

Deno.test("createVitestBenchmarkResult preserves measured Vitest samples", () => {
  const result = createVitestBenchmarkResult({
    name: "bitmap",
    recordedAt: "2026-08-27T00:00:00.000Z",
    environment: {
      runtime: { name: "node", version: "v24.5.0" },
      platform: "darwin-arm64",
      logicalCpus: 10,
      cpu: "Apple M5",
      adapter: null,
    },
    cases: [
      { name: "small > SIMD", samplesMs: [3, 1, 2], fullSampleCount: 100 },
      { name: "small > JS", samplesMs: [6, 4, 5, 7] },
    ],
    sampleLimit: 3,
  });

  assertEquals(result.timing, { warmups: 0, samples: 3, operationsPerSample: 1 });
  assertEquals(result.measurements[0]?.samplesMs, [3, 1, 2]);
  assertEquals(result.measurements[0]?.medianMs, 2);
  assertEquals(result.measurements[1]?.samplesMs, [6, 5, 7]);
  assertEquals(result.input.shape, { benchmarkCount: 2, runner: "vitest" });
  assertEquals(result.metrics?.fullSampleCountMax, 100);
});

Deno.test("createVitestBenchmarkResult rejects missing raw samples", () => {
  assertThrows(
    () => {
      createVitestBenchmarkResult({
        name: "empty",
        recordedAt: "2026-08-27T00:00:00.000Z",
        environment: {
          runtime: { name: "node", version: "v24.5.0" },
          platform: "darwin-arm64",
          logicalCpus: 10,
          cpu: "Apple M5",
          adapter: null,
        },
        cases: [{ name: "missing", samplesMs: [] }],
      });
    },
    "raw samples",
  );
});
