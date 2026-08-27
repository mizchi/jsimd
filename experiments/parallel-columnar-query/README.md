# Parallel columnar query experiment

This experiment tests the first application-composition boundary for jsimd: long-lived Workers scan
an immutable i32 column directly in shared Wasm memory and publish only partial aggregates.

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
                   cache-line partial results
                              |
                        scalar final merge
```

Each 32-byte page descriptor records the data offset, logical row range, and signed `min/max` zone
map. Workers are persistent. Query bounds and one snapshot generation are published with an epoch,
dispatched over per-worker SPSC rings, and completed through a shared wait group. Workers
dynamically claim coarse pages through one atomic counter. Each result slot is 64 bytes so workers
never write the same cache line.

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
```

Set `JSIMD_QUERY_ROWS` to change the default 8,388,608-row benchmark.

The browser comparison with DuckDB-Wasm requires Chrome and serves the fixture with COOP/COEP:

```sh
just bench-parallel-columnar-duckdb-browser
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

The current scope is one immutable raw i32 column and one `minimum <= value < maximum` count/sum
operator. It does not yet provide page-granular publication, adaptive page decoding, selection
masks, or group-by.

## Recorded result

Apple Silicon, Deno 2.6.4 / V8 14.2, 33,554,432 i32 rows (128 MiB), 25% selectivity, 65,536 rows per
page, median of 11 warm samples:

| execution               |    median |  vs JS | vs single Wasm |
| :---------------------- | --------: | -----: | -------------: |
| optimized JavaScript    | 105.09 ms |  1.00x |              — |
| single-thread Wasm SIMD |   9.51 ms | 11.05x |          1.00x |
| 1 Worker                |  11.75 ms |  8.94x |          0.81x |
| 2 Workers               |   7.06 ms | 14.88x |          1.35x |
| 4 Workers               |   4.73 ms | 22.22x |          2.01x |
| 8 Workers               |   2.44 ms | 43.07x |          3.90x |

The same query over 32 MiB took 2.96 ms on direct single-thread Wasm, 2.16 ms on one Worker, and
2.34–2.41 ms with 2–8 Workers. At that size, additional Workers provide no gain. A future planner
must therefore choose the execution width from estimated bytes/pages rather than always using every
logical CPU.

The complete machine-readable result is in `benchmarks/baseline.json`. Each Worker count was
measured in a fresh process to avoid retaining previous 256 MiB double-buffer allocations.
Initialization remains significant (263–362 ms here), so this design requires resident Workers and
repeated queries. Immutable replacement reserves roughly twice the logical column bytes; a product
engine must use page-granular generations or bounded snapshots when that overhead is unacceptable.

## DuckDB-Wasm comparison

The comparison fixture runs in cross-origin-isolated Chrome and gives both implementations the same
33,554,432-value i32 column (128 MiB), 25%-selective range predicate, and `count + sum` aggregate.
DuckDB creates the column inside SQL, so neither implementation pays Arrow/file transport in the
recorded warm-query latency. Every mode runs in a fresh browser process, with five warmups followed
by the median of 11 samples.

Apple Silicon, Headless Chrome 152, `@duckdb/duckdb-wasm` 1.32.0 (DuckDB v1.4.3):

| execution                | threads |   median | vs DuckDB `eh` |
| :----------------------- | ------: | -------: | -------------: |
| jsimd direct Wasm SIMD   |       1 |  4.55 ms |          7.61x |
| jsimd persistent Workers |       8 |  1.30 ms |         26.53x |
| DuckDB-Wasm `eh`         |       1 | 34.63 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 63.70 ms |          0.54x |

The result confirms the useful niche, but is not a general claim that jsimd is a faster database.
The jsimd path is a hand-assembled, non-nullable, single-column kernel with no SQL parser, planner,
or Arrow result materialization. DuckDB provides a complete analytical SQL engine. Its experimental
threaded `coi` build did not speed up this simple scan; jsimd's coarse page scheduling scaled 3.49x
over its own direct Wasm result. This supports extracting common scan/aggregate kernels, while
joins, group-by, null semantics, persistence, and general SQL still need separate evaluation.

DuckDB's documentation describes the default Wasm client as single-threaded and the `coi` bundle as
experimental. The fixture selects `eh` and `coi` explicitly instead of relying on automatic bundle
selection, verifies `current_setting('threads')`, and serves the required COOP/COEP headers. See
[Known Issues](https://duckdb.org/docs/current/clients/wasm/known_issues) and
[Deploying DuckDB-Wasm](https://duckdb.org/docs/current/clients/wasm/deploying_duckdb_wasm).

Bundle cost also differs substantially. The jsimd-specific generated assets in this fixture contain
two Wasm modules totaling 634 bytes gzip plus a 6.2 KiB gzip Worker. DuckDB's Wasm module is about
7.3–7.4 MiB gzip, plus 184 KiB gzip for the `eh` Worker or 354 KiB gzip for the `coi` main/pthread
Workers. The exact measurements and raw samples are in `benchmarks/duckdb-browser.json`.
