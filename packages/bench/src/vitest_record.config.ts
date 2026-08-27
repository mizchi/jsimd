import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    benchmark: {
      includeSamples: true,
      reporters: ["./packages/bench/src/vitest_result_reporter.ts"],
    },
  },
});
