# Parallel columnar query experiment

This experiment tests the first application-composition boundary for jsimd: long-lived Workers scan
an immutable i32 column directly in shared Wasm memory and publish only partial aggregates.

The second kernel keeps an i32 filter column, i32 measure column, and u8 group key column in the
same immutable snapshot. It applies ZoneMap pruning, filters four rows at a time with SIMD, updates
worker-private `count/sum/min/max` states, and merges those states only after the Worker barrier.

It is deliberately not a public package entrypoint. A higher-level schema, planner, catalog, and
persistent storage policy may move to a separate repository after the low-level ABI and performance
boundary are measured here.

The possible DuckDB-facing physical execution layers are recorded separately in
[`OLAP_DESIGN.md`](./OLAP_DESIGN.md). That document is a design hypothesis, not an implementation
commitment or public API roadmap.

## Execution model

```text
Int32Array --publish--> double-buffered immutable snapshot
                              |
                    atomic next-page claim
                              |
              Worker-local Wasm SIMD count + sum
                              |
                 cache-line aggregate blocks
                              |
                     Wasm SIMD final merge
```

Each 32-byte page descriptor records the data offset, logical row range, and signed `min/max` zone
map. Workers are persistent. Query bounds and one snapshot generation are published with an epoch,
dispatched over per-worker SPSC rings, and completed through a shared wait group. Workers
dynamically claim coarse pages through one atomic counter. Each result slot starts on a separate
cache line, so workers never write the same cache line.

There is no atomic `v128` operation. Immutability and exclusive page claims make the SIMD loads
safe; the only atomic operations are task publication, page claims, cancellation, completion, and
result-epoch publication.

`replace()` writes the inactive snapshot and atomically publishes its generation. Active queries
hold a reader guard over exactly one immutable generation. `cancelCurrent()` stops at page
boundaries, and `restartWorkers()` orderly replaces the Worker pool without discarding the current
snapshot.

## Run

```sh
just test-parallel-columnar-query
just bench-parallel-columnar-query
just bench-parallel-columnar-group-by
JSIMD_GROUP_WORKLOAD=logs just bench-parallel-columnar-group-by
just bench-record-parallel-columnar-query
just bench-record-parallel-columnar-group-by
just bench-record-parallel-columnar-log-group-by
```

Set `JSIMD_QUERY_ROWS` to change the default 8,388,608-row benchmark.

The browser comparison with DuckDB-Wasm requires Chrome and serves the fixture with COOP/COEP:

```sh
just bench-parallel-columnar-duckdb-browser
just bench-record-parallel-columnar-duckdb-browser
```

## Performance contract

The benchmark separates:

- an optimized typed-array JavaScript loop;
- the identical page ABI and SIMD kernel on one thread;
- 1/2/4/8 long-lived Workers over shared memory.

Worker construction is reported but excluded from warm query latency. This reflects a resident
analytical engine, not one-shot queries. Small inputs and selective queries that touch only one or a
few pages should remain single-threaded; Worker dispatch has a fixed cost and is not expected to win
there. The experiment is useful only if large scans scale beyond the single-thread Wasm result.

The current scope includes one immutable raw i32 count/sum scan and a fused low-cardinality u8
group-by over i32 filter/measure columns. It does not yet provide page-granular publication,
adaptive page decoding, null handling, or a reusable selection-mask pipeline.

## Low-cardinality group-by result

Apple Silicon, Deno 2.6.4 / V8 14.2, 8,388,608 rows (72 MiB across two i32 columns and one u8
column), eight groups, 50% selectivity, 65,536 rows per page, median of 11 warm samples:

| execution               |   median | vs JS | vs single Wasm |
| :---------------------- | -------: | ----: | -------------: |
| optimized JavaScript    | 45.83 ms | 1.00x |          0.80x |
| single-thread Wasm SIMD | 36.49 ms | 1.26x |          1.00x |
| 8 Workers               |  7.89 ms | 5.81x |          4.63x |

The SIMD kernel only vectorizes the range predicate. Selected lanes still update scalar per-group
states, so the single-thread gain is modest and varies with selectivity and group distribution. The
larger gain comes from immutable page ownership and Worker-local aggregation without atomics in the
hot loop. Final Worker states are now combined through the experimental cache-line-aligned
`AggregateStateBlock`: count/null-count/sum/min/max use a SoA layout, average is derived, and four
groups are reduced per SIMD iteration. At eight groups the merge is too small to claim an isolated
speedup; a higher-cardinality benchmark is required before making this a public API. Construction
took 218.54 ms and is excluded from warm latency, so this remains a resident OLAP workload rather
than a one-shot conversion win. The raw result is in `benchmarks/group-by.json`.

## Recorded result

Apple Silicon, Deno 2.6.4 / V8 14.2, 33,554,432 i32 rows (128 MiB), 25% selectivity, 65,536 rows per
page, median of 11 warm samples:

| execution               |   median |  vs JS | vs single Wasm |
| :---------------------- | -------: | -----: | -------------: |
| optimized JavaScript    | 98.18 ms |  1.00x |              — |
| single-thread Wasm SIMD |  5.57 ms | 17.63x |          1.00x |
| 1 Worker                |  6.98 ms | 14.07x |          0.80x |
| 2 Workers               |  4.62 ms | 21.26x |          1.21x |
| 4 Workers               |  2.38 ms | 41.32x |          2.34x |
| 8 Workers               |  2.34 ms | 41.92x |          2.38x |

The page-pruned 72 MiB log workload shows the opposite boundary: direct Wasm took 1.93 ms while
eight Workers took 2.32 ms. A future planner must therefore choose execution width from estimated
pages remaining after pruning rather than total bytes or logical CPU count.

The complete machine-readable result is in `benchmarks/baseline.json`. Every result uses the shared
versioned envelope and retains its 11 raw samples. Worker counts construct and dispose separate
query instances sequentially in one process. Initialization remains significant (174–277 ms here),
so this design requires resident Workers and repeated queries. Immutable replacement reserves
roughly twice the logical column bytes; a product engine must use page-granular generations or
bounded snapshots when that overhead is unacceptable.

## DuckDB-Wasm comparison

The comparison fixture runs in cross-origin-isolated Chrome and gives both implementations the same
33,554,432-value i32 column (128 MiB), 25%-selective range predicate, and `count + sum` aggregate.
DuckDB creates the column inside SQL, so neither implementation pays Arrow/file transport in the
recorded warm-query latency. Every mode runs in a fresh browser process, with five warmups followed
by the median of 11 samples.

Apple Silicon, Headless Chrome 152, `@duckdb/duckdb-wasm` 1.32.0 (DuckDB v1.4.3):

| execution                | threads |   median | vs DuckDB `eh` |
| :----------------------- | ------: | -------: | -------------: |
| jsimd direct Wasm SIMD   |       1 |  4.70 ms |          9.18x |
| jsimd persistent Workers |       8 |  1.31 ms |         33.10x |
| DuckDB-Wasm `eh`         |       1 | 43.19 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 62.91 ms |          0.69x |

The result confirms the useful niche, but is not a general claim that jsimd is a faster database.
The jsimd path is a hand-assembled, non-nullable, single-column kernel with no SQL parser, planner,
or Arrow result materialization. DuckDB provides a complete analytical SQL engine. Its experimental
threaded `coi` build did not speed up this simple scan; jsimd's coarse page scheduling scaled 3.61x
over its own direct Wasm result. This supports extracting common scan/aggregate kernels, while
joins, group-by, null semantics, persistence, and general SQL still need separate evaluation.

DuckDB's documentation describes the default Wasm client as single-threaded and the `coi` bundle as
experimental. The fixture selects `eh` and `coi` explicitly instead of relying on automatic bundle
selection, verifies `current_setting('threads')`, and serves the required COOP/COEP headers. See
[Known Issues](https://duckdb.org/docs/current/clients/wasm/known_issues) and
[Deploying DuckDB-Wasm](https://duckdb.org/docs/current/clients/wasm/deploying_duckdb_wasm).

The same Chrome fixture also runs a Q1-shaped three-column workload with an i32 range filter, eight
u8 groups, and `count/sum/min/max`. At 16,777,216 rows (144 MiB logical input), all eight output
groups matched across the four modes:

| execution                | threads |   median | vs DuckDB `eh` |
| :----------------------- | ------: | -------: | -------------: |
| jsimd direct Wasm SIMD   |       1 | 17.80 ms |          3.72x |
| jsimd persistent Workers |       8 |  4.53 ms |         14.61x |
| DuckDB-Wasm `eh`         |       1 | 66.25 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 55.70 ms |          1.19x |

For a timestamp-sorted log workload, the predicate selects 10% of 16,777,216 rows and ZoneMaps skip
the other pages. In Chrome, direct jsimd took 2.62 ms, 8 Workers took 0.675 ms, DuckDB `eh` took
11.02 ms, and DuckDB `coi` took 5.88 ms. All group states matched. In the smaller 8,388,608-row Deno
run, however, dispatch dominated after pruning: direct jsimd took 1.93 ms while 8 Workers took 2.32
ms. A planner therefore needs to choose execution width from pages remaining after pruning, not
total table size. Raw samples are in `benchmarks/log-group-by.json` and
`benchmarks/duckdb-browser-logs.json`.

Bundle cost also differs substantially. The jsimd-specific generated assets in this fixture contain
two Wasm modules totaling 808 bytes gzip plus a 6.2–6.3 KiB gzip Worker. DuckDB's Wasm module is
about 7.4–7.5 MiB gzip, plus 186 KiB gzip for the `eh` Worker or 356 KiB gzip for the `coi`
main/pthread Workers. The exact measurements and raw samples are in
`benchmarks/duckdb-browser.json`.
