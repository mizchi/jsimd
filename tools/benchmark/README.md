# Benchmark infrastructure

Experimental benchmark results use a versioned envelope from `result.ts`. It records the runtime,
CPU visibility, optional GPU adapter, warmup/sample counts, input shape, correctness checks, and raw
latency samples. Browser code should use `detectBenchmarkEnvironment()` and post the complete result
to the host runner.

`measure.ts` makes the timed boundary explicit:

- `resident`: construction and input transfer happened before timing;
- `construction-inclusive`: construction and execution are timed together;
- `materialization-inclusive`: execution and conversion to caller-visible output are timed together;
- `end-to-end`: the experiment defines and documents its complete external operation.

Microbenchmarks may contain only `resident` measurements. System comparisons should include an
`end-to-end` boundary whenever the external operation can be defined consistently. Comparisons must
only use matching boundaries.

`browser_runner.ts` serves a built fixture, launches a fresh Chromium profile, optionally enables
cross-origin isolation, and returns JSON posted to `/__jsimd_result`. It is shared by the IndexedDB
and DuckDB browser experiments.

Run `just check-benchmark-results` to validate versioned JSON stored under every experiment and
example `benchmarks/` directory. All committed benchmark results must use schema version 1.

Vitest's built-in JSON output drops its sample array. `vitest_record.config.ts` enables retained
Tinybench samples and `vitest_result_reporter.ts` writes a bounded, uniform number of actual samples
to the shared envelope. Use `just bench-record-vitest <suite> <output>` rather than `--outputJson`.

Measurement names are unique within a result. Raw `samplesMs` are retained in the order exposed by
the runner and must match the global sample count; historical medians are never expanded into
synthetic samples.

`build-budgets.json` assigns deterministic gzip ceilings to every public subpath fixture. The normal
test suite remains the gate for admitted workload correctness; latency samples are recorded for
review but deliberately have no hard CI threshold. Run `just check-build-budgets` after building the
isolated Vite fixtures.
