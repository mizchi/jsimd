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

Every result must contain at least one `end-to-end` measurement. Additional boundaries can be
recorded for diagnosis, but comparisons should only use matching boundaries.

`browser_runner.ts` serves a built fixture, launches a fresh Chromium profile, optionally enables
cross-origin isolation, and returns JSON posted to `/__jsimd_result`. It is shared by the IndexedDB
and DuckDB browser experiments.

Run `just check-benchmark-results` to validate versioned JSON stored under each experiment's
`benchmarks/` directory. Legacy Vitest and earlier experiment result formats remain readable during
incremental migration; every newly recorded result should use schema version 1.

`build-budgets.json` assigns deterministic gzip ceilings to every public subpath fixture. The normal
test suite remains the gate for admitted workload correctness; latency samples are recorded for
review but deliberately have no hard CI threshold. Run `just check-build-budgets` after building the
isolated Vite fixtures.
