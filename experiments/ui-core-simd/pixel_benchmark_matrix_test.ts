import { createPixelBenchmarkCases } from "./pixel_benchmark_matrix.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("pixel benchmark matrix crosses runtime, size, and occupancy", () => {
  assertEquals(
    createPixelBenchmarkCases([256, 512], [0.05, 0.75], ["cpu", "webgpu"], ["full"]),
    [
      { runtime: "cpu", width: 256, occupancy: 0.05, region: "full" },
      { runtime: "webgpu", width: 256, occupancy: 0.05, region: "full" },
      { runtime: "cpu", width: 256, occupancy: 0.75, region: "full" },
      { runtime: "webgpu", width: 256, occupancy: 0.75, region: "full" },
      { runtime: "cpu", width: 512, occupancy: 0.05, region: "full" },
      { runtime: "webgpu", width: 512, occupancy: 0.05, region: "full" },
      { runtime: "cpu", width: 512, occupancy: 0.75, region: "full" },
      { runtime: "webgpu", width: 512, occupancy: 0.75, region: "full" },
    ],
  );
});

Deno.test("pixel benchmark matrix accepts the off-thread active runtime", () => {
  assertEquals(createPixelBenchmarkCases([256], [0.25], ["worker"], ["spot"]), [
    { runtime: "worker", width: 256, occupancy: 0.25, region: "spot" },
  ]);
});

Deno.test("pixel benchmark matrix rejects unsupported dimensions", () => {
  let errors = 0;
  for (
    const invoke of [
      () => createPixelBenchmarkCases([], [0.25], ["cpu"]),
      () => createPixelBenchmarkCases([512], [0.2], ["cpu"]),
      () => createPixelBenchmarkCases([512], [0.25], ["cpu"], []),
    ]
  ) {
    try {
      invoke();
    } catch (error) {
      if (error instanceof RangeError) errors++;
    }
  }
  assertEquals(errors, 3);
});
