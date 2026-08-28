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
just bench-parallel-columnar-local-group-hash
just bench-parallel-columnar-hash-join
JSIMD_GROUP_WORKLOAD=logs just bench-parallel-columnar-group-by
just bench-record-parallel-columnar-query
just bench-record-parallel-columnar-group-by
just bench-record-parallel-columnar-log-group-by
just bench-record-parallel-columnar-hash-join
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

The current scope includes one immutable raw i32 count/sum scan, a fused low-cardinality u8
group-by, and a page-pruned sparse u32 group-by with byte validities. The page-query path does not
yet connect adaptive page decoding or a reusable selection-mask pipeline.

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

## Sparse u32 group-by result

`LocalGroupHashTableU32` is an experimental fixed-capacity SwissTable for arbitrary u32 group keys.
Each Worker exclusively builds one local table. After the barrier, each Worker owns one radix output
partition and merges that partition from every local table. The table stores nullable i32
`count/nullCount/sum/min/max` state; average is derived from sum/count. There is no concurrently
mutated global hash table.

Apple M5, Deno 2.6.4 / V8 14.2, 1,048,576 resident rows, four persistent Workers, median of 11 warm
samples. Timings include clearing prior state and materializing every output group:

| distinct groups | JS `Map` | single Wasm | 4 Workers | single vs JS | Workers vs JS |
| --------------: | -------: | ----------: | --------: | -----------: | ------------: |
|              16 | 19.58 ms |    16.27 ms |   5.81 ms |        1.20x |         3.37x |
|             256 | 15.82 ms |    15.91 ms |   5.66 ms |        0.99x |         2.80x |
|           4,096 | 40.52 ms |    27.04 ms |   9.20 ms |        1.50x |         4.40x |
|          65,536 | 77.10 ms |    53.77 ms |  38.72 ms |        1.43x |         1.99x |

The hash table is not a replacement for the existing dense low-cardinality group state. When a small
key domain is known, direct indexing avoids hashing and should remain the planner choice. The hash
path is intended for sparse or unknown u32 domains. It reserves capacity in advance, uses at most
7/8 of its slots, and leaves partial state on capacity failure so the caller must discard or clear
it before retrying. Worker startup is excluded; resident input, merge, and output materialization
are included. The shared experiment kernel containing scans, aggregate reduction, and hash grouping
is 1.43 kB gzip. Raw samples are in `benchmarks/local-group-hash*.json`.

The same hash state is also connected to an immutable range-filtered query. Each 65,536-row page
stores an i32 ZoneMap; surviving rows are filtered four at a time before scalar SwissTable updates.
The Worker phase builds private tables and then performs the same radix-owner merge. On Apple M5 in
Headless Chrome 152, 16,777,216 rows, 2,048 u32 keys scattered across the full key space, nullable
i32 values, and 10% selectivity produced these medians over 11 warm samples:

| execution                | threads |   median | vs DuckDB `eh` |
| :----------------------- | ------: | -------: | -------------: |
| jsimd direct Wasm SIMD   |       1 | 13.33 ms |          1.66x |
| jsimd persistent Workers |       8 |  3.87 ms |          5.74x |
| DuckDB-Wasm `eh`         |       1 | 22.17 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 14.86 ms |          1.49x |

ZoneMaps skipped 230 of 256 pages. Timings include materializing and sorting all 2,048 aggregate
states, but exclude immutable input copy, table allocation, Worker startup, and DuckDB table
construction. This is a specialized resident physical operator, not a general SQL comparison. The
jsimd Worker asset is 4.67 kB gzip and the shared experiment Wasm is 1.43 kB gzip. Raw samples are
in `benchmarks/duckdb-browser-sparse.json`; `JSIMD_QUERY_GROUPS` changes the cardinality.

The recorded cardinality is 2,048 because DuckDB `coi` 1.32.0 repeatedly returned an empty result
for the 4,096-group calibration at 1,048,576 rows, while `eh` and both jsimd modes returned all
groups. The fixture treats that as a correctness failure rather than recording incomparable timings.
This may be version-specific and is not counted as a jsimd speedup.

## Partitioned u32 hash join result

`PartitionedHashJoinTableU32` is an experimental fixed-capacity equi-join substrate. Each radix
partition has independent 16-byte SIMD fingerprint groups, duplicate-key chains, and an optional
128-bit-blocked Bloom filter. The build table is immutable during probe. Direct Wasm or persistent
Workers write exact probe/build row-ID pairs into caller-owned buffers; Worker shards never overlap,
and concatenating them in Worker order preserves deterministic probe-major/build-input order.

Apple M5, Deno 2.6.4 / V8 14.2, 131,072 build rows, 65,536 distinct u32 keys, two build rows per
key, 1,048,576 resident probe rows, four partitions and four persistent Workers, median of 11 warm
samples:

| probe hits | JS `Map` | direct Wasm | direct + Bloom | 4 Workers | 4 Workers + Bloom |
| ---------: | -------: | ----------: | -------------: | --------: | ----------------: |
|        10% | 67.84 ms |    11.42 ms |        9.24 ms |   4.36 ms |           3.95 ms |
|        50% | 80.52 ms |    16.49 ms |       16.97 ms |   5.33 ms |           6.73 ms |
|        90% | 62.31 ms |    17.50 ms |       25.35 ms |   6.43 ms |           7.75 ms |

Probe timing includes materializing all exact row-ID pairs. Resident table construction and Worker
startup are excluded and reported separately in the raw result. The Bloom filter rejected 89.81%,
49.90%, and 9.98% of probes respectively. It is useful for miss-heavy joins but slower when most
keys hit, so a planner must estimate miss rate before enabling it. The table reserves capacity in
advance and leaves partial state after build-capacity failure; callers must clear or discard it
before retrying. This is not a general join planner and currently supports only `u32` equality keys.
Several direct and JavaScript samples were noisy in this run, so the machine-readable result keeps
all samples and p95 values in `benchmarks/partitioned-hash-join.json`; the table should be read as a
crossover result rather than a fine-grained latency claim.

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

The sparse-u32 comparison above is the fourth browser workload. Unlike Q1's fixed eight-slot state,
it exercises nullable aggregation, SIMD fingerprint probing, page pruning, Worker-local tables, and
radix-owner merge. Its 8-Worker jsimd result was 3.84x faster than the explicitly threaded DuckDB
`coi` result while returning the same 2,048 complete-u32 key states.

Bundle cost also differs substantially. The jsimd-specific generated assets in this fixture contain
two Wasm modules totaling 808 bytes gzip plus a 6.2–6.3 KiB gzip Worker. DuckDB's Wasm module is
about 7.4–7.5 MiB gzip, plus 186 KiB gzip for the `eh` Worker or 356 KiB gzip for the `coi`
main/pthread Workers. The exact measurements and raw samples are in
`benchmarks/duckdb-browser.json`.
