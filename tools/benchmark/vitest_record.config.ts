import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    benchmark: {
      includeSamples: true,
      reporters: ["./tools/benchmark/vitest_result_reporter.ts"],
    },
  },
});
