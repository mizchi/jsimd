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
Int32Array ---------> raw shared pages -----------+
SchemaEngine pages -> constant/FOR/raw payloads --+--> immutable snapshot
                                                   |
                                         atomic next-page claim
                                                   |
                                   Worker-local Wasm SIMD count + sum
                                                   |
                                      cache-line aggregate blocks
```

Each 32-byte page descriptor records the data offset, logical row range, signed `min/max` ZoneMap,
physical encoding, and FOR bit width. Workers are persistent. Query bounds and one snapshot
generation are published with an epoch, dispatched over per-worker SPSC rings, and completed through
a shared wait group. Workers dynamically claim coarse pages through one atomic counter. Each result
slot starts on a separate cache line, so workers never write the same cache line.

There is no atomic `v128` operation. Immutability and exclusive page claims make the SIMD loads
safe; the only atomic operations are task publication, page claims, cancellation, completion, and
result-epoch publication.

Raw `replace()` writes the inactive snapshot and atomically publishes its generation. Active queries
hold a reader guard over exactly one immutable generation. `cancelCurrent()` stops at page
boundaries, and `restartWorkers()` orderly replaces the Worker pool without discarding the current
snapshot.

`SchemaEngine.readI32SnapshotPages()` pins one page generation and reads non-nullable i32 snapshot
bytes directly from the backend without populating its host/Wasm resident cache.
`I32AggregatePipeline.createFromSchema()` validates the snapshots, copies only their encoded
constant/FOR/raw payloads into shared memory once, and scans FOR values four at a time inside Wasm.
It does not reconstruct a complete `Int32Array`. IndexedDB and filesystem reads still necessarily
copy bytes into JavaScript before the shared-memory copy; this is not a zero-copy storage claim.

## Run

```sh
just test-parallel-columnar-query
just bench-parallel-columnar-query
just bench-parallel-columnar-group-by
just bench-parallel-columnar-local-group-hash
just bench-parallel-columnar-hash-join
just bench-parallel-columnar-physical-pipeline
JSIMD_GROUP_WORKLOAD=logs just bench-parallel-columnar-group-by
just bench-record-parallel-columnar-query
just bench-record-parallel-columnar-group-by
just bench-record-parallel-columnar-log-group-by
just bench-record-parallel-columnar-hash-join
just bench-record-parallel-columnar-physical-pipeline
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

The current scope includes immutable raw and adaptive i32 count/sum scans, a fused low-cardinality
u8 group-by, and a page-pruned sparse u32 group-by with byte validities. Adaptive SchemaEngine input
currently supports only non-nullable i32 snapshots and still lacks a reusable multi-column
selection-mask pipeline.

## Physical execution planning

`ExecutionChunkI32` separates immutable row-range/ZoneMap metadata from execution state.
`PhysicalExecutionPlanner` estimates direct page cost against persistent-Worker dispatch and
parallel efficiency. `I32AggregatePipeline` applies that decision to the same shared-memory page ABI
and returns the plan, cost estimates, and reason alongside `count` and `sum`. Callers can force
`direct` or `workers` for calibration and unusual latency requirements. `I32GroupByU8Pipeline`
applies the same contract with a separate low-cardinality group-by calibration; it does not reuse
the cheaper count+sum profile.

Apple M5, Deno 2.6.4, 33,554,432 sorted resident i32 rows, 65,536 rows per page, eight persistent
Workers, median of 11 warm samples:

| surviving pages | direct SIMD | 8 Workers | default choice |
| --------------: | ----------: | --------: | :------------- |
|               1 |     0.09 ms |   2.31 ms | direct         |
|              16 |     0.20 ms |   2.34 ms | direct         |
|              64 |     0.58 ms |   2.33 ms | direct         |
|             128 |     1.15 ms |   2.29 ms | direct         |
|             256 |     2.37 ms |   2.29 ms | direct         |
|             512 |     4.56 ms |   2.28 ms | Workers        |

At 256 pages the two modes were within 2%, so the planner intentionally keeps direct execution until
the gain is material. It chose the faster mode in seven of eight cases and stayed within 5% in all
cases; the 256-page ordering is too close to treat as a stable crossover. The fixed approximately
2.3 ms Deno dispatch/wakeup boundary is runtime-specific. Headless Chromium 152 on the same machine
measured roughly 0.07-0.10 ms of fitted dispatch/wakeup cost: direct won at four 65,536-row pages
(0.050 ms versus 0.075 ms), while Workers won at 16 pages (0.105 ms versus 0.145 ms) and reached
3.71x at 512 pages. The Chromium profile selected the fastest mode in all eight cases. The 16-page
boundary varied across independent runs, so callers with strict latency requirements can still force
an execution mode. Construction, input copy, and Worker startup are excluded. Raw samples are in
`benchmarks/physical-pipeline.json` and `benchmarks/browser-physical-pipeline.json`.

The operator-specific group-by crossover was measured separately on the same runtime, page size, and
Worker count. Each selected row updates one of eight `count/sum/min/max` states:

| surviving pages | direct SIMD | 8 Workers | default choice |
| --------------: | ----------: | --------: | :------------- |
|               1 |     0.13 ms |   2.34 ms | direct         |
|               4 |     0.49 ms |   2.32 ms | direct         |
|              16 |     1.84 ms |   2.31 ms | direct         |
|              32 |     3.87 ms |   2.31 ms | Workers        |
|              64 |     7.95 ms |   2.34 ms | Workers        |
|             512 |    63.10 ms |  14.02 ms | Workers        |

Group-by crosses between 16 and 32 pages, far earlier than count+sum. The dedicated profile selected
the measured fastest mode in all eight tested cases. This benchmark uses predictable dense u8 group
IDs and resident raw columns; different cardinality, hashing, encoded inputs, or a browser runtime
need their own profile. Raw samples are in `benchmarks/group-physical-pipeline.json`.

The planner no longer prices every page equally. The Deno default separates descriptor/call overhead
from constant/raw/FOR row costs, calibrated by both 65,536-row raw pages and 256-row SchemaEngine
pages. It remains configurable rather than a universal runtime constant.

## Adaptive SchemaEngine pipeline result

Apple M5, Deno 2.6.4, 8,388,608 rows, 32,768 physical 256-row pages, eight persistent Workers,
median of 11 warm samples:

| encoding | stored/raw | optimized JS | direct Wasm | 8 Workers | fastest vs JS |
| :------- | ---------: | -----------: | ----------: | --------: | ------------: |
| constant |      0.02x |     24.77 ms |     1.78 ms |   2.51 ms |        13.93x |
| FOR-8    |      0.27x |     35.01 ms |    11.07 ms |   3.78 ms |         9.26x |
| raw      |      1.02x |     38.41 ms |     2.66 ms |   2.50 ms |        15.36x |

The constant kernel aggregates each page in O(1), so direct execution remains faster even across
32,768 pages. FOR decoding is compute-heavy enough to scale across Workers. Raw pages only narrowly
repay Worker dispatch at this input size. The encoding-aware planner selected the measured fastest
mode for all three encodings after calibration.

The cross-origin-isolated Chromium run reached the same encoding-dependent decisions, but exposed a
second runtime cost: atomic page claims become significant across 32,768 small pages. Constant pages
favored direct execution (1.54 ms versus 2.11 ms), FOR-8 favored Workers (2.92 ms versus 10.46 ms),
and raw pages were tied within 1% with direct retained (2.26 ms versus 2.28 ms). The Chromium model
therefore prices Worker page claims separately from direct descriptor traversal. It selected all
three measured modes; raw samples are in `benchmarks/browser-adaptive-pipeline.json`.

Schema-to-shared construction medians were 68.13 ms (constant), 101.23 ms (FOR), and 112.97 ms
(raw). They include backend reads, snapshot validation, the single encoded payload copy, shared
allocation, Wasm instantiation, Worker startup, and disposal. Constant pages carry no value payload;
FOR payloads occupy 25% of raw input, while raw snapshots add about 2% framing overhead. Resident
query speedups therefore do not make this suitable for one-shot scans. Raw samples are in
`benchmarks/adaptive-pipeline.json`.

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
is 2.26 kB gzip after adding adaptive snapshot scanning. Raw samples are in
`benchmarks/local-group-hash*.json`.

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
jsimd Worker asset is 4.67 kB gzip and the shared experiment Wasm is 2.26 kB gzip. Raw samples are
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
| jsimd direct Wasm SIMD   |       1 |  4.10 ms |          7.22x |
| jsimd persistent Workers |       8 |  1.25 ms |         23.66x |
| DuckDB-Wasm `eh`         |       1 | 29.58 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 61.17 ms |          0.48x |

The result confirms the useful niche, but is not a general claim that jsimd is a faster database.
The jsimd path is a hand-assembled, non-nullable, single-column kernel with no SQL parser, planner,
or Arrow result materialization. DuckDB provides a complete analytical SQL engine. Its experimental
threaded `coi` build did not speed up this simple scan; jsimd's coarse page scheduling scaled 3.28x
over its own direct Wasm result. This supports extracting common scan/aggregate kernels. Group-by
and nullable aggregation are evaluated below, while joins, persistence, and general SQL remain
outside this experiment.

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
| jsimd direct Wasm SIMD   |       1 | 14.64 ms |          3.48x |
| jsimd persistent Workers |       8 |  3.29 ms |         15.51x |
| DuckDB-Wasm `eh`         |       1 | 51.02 ms |          1.00x |
| DuckDB-Wasm `coi`        |       8 | 54.80 ms |          0.93x |

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

Bundle cost also differs substantially. The current jsimd fixture contains two Wasm modules totaling
2.53 KiB gzip, plus 6.28 KiB gzip for the Q6 Worker or 7.11 KiB gzip for the Q1 Worker. DuckDB's
Wasm module is 7.42 MiB gzip for `eh` or 7.49 MiB gzip for `coi`, plus 186 KiB gzip for the `eh`
Worker or 356 KiB gzip for the `coi` main/pthread Workers. These are fixture asset sizes, not a
feature-equivalent package-size comparison: DuckDB includes a general SQL database while jsimd
includes only the kernels used here. Exact byte counts and raw samples are in
`benchmarks/duckdb-browser.json` and `benchmarks/duckdb-browser-q1.json`.

### When this path is likely to win

The recorded results point to a narrower rule than "Wasm is faster than SQL": keep typed numeric
columns resident, reuse an initialized executor, fuse a large amount of work into each call, and
return a small aggregate state. The following cases match that rule.

#### Repeated range aggregates over a large resident column

This is equivalent to `SELECT count(*), sum(value) FROM t WHERE value >= ? AND value < ?`.
Initialization and the initial column copy happen once; subsequent calls use bulk page kernels
rather than crossing the JS/Wasm boundary once per row.

```ts
import { I32AggregatePipeline } from "@mizchi/jsimd-olap/range-aggregate";

async function runRanges(
  residentValues: Int32Array,
  ranges: readonly (readonly [number, number])[],
) {
  await using pipeline = await I32AggregatePipeline.create(residentValues, {
    workerCount: 8,
    pageRows: 65_536,
  });

  for (const [minimum, maximum] of ranges) {
    const result = await pipeline.aggregateBetween(minimum, maximum);
    console.log(result.count, result.sum, result.plan.execution);
  }
}
```

The 33,554,432-row Q6-shaped benchmark is the strongest example: direct SIMD was 7.22x faster than
single-thread DuckDB, and persistent Workers were 23.66x faster. A one-shot call that includes
pipeline construction does not have this property.

#### Low-cardinality group-by, especially with page pruning

Dense `u8` group IDs let each Worker update a fixed-size local aggregate state. If the filter column
is ordered or clustered, per-page `min/max` metadata can reject whole pages before touching the
value and group columns.

```ts
import { I32GroupByU8Pipeline } from "@mizchi/jsimd-olap/group-by-u8";

async function aggregateLogWindow(
  timestamps: Int32Array,
  values: Int32Array,
  categoryIds: Uint8Array,
  start: number,
  end: number,
) {
  await using pipeline = await I32GroupByU8Pipeline.create(
    { filter: timestamps, values, groups: categoryIds },
    { groupCount: 8, workerCount: 8, pageRows: 65_536 },
  );
  const result = await pipeline.aggregateBetween(start, end);
  console.log(result.groups, result.pagesSkipped, result.plan.execution);
}
```

The unpruned Q1-shaped benchmark was 15.51x faster than the fastest DuckDB mode with eight output
groups. The timestamp-sorted log benchmark skipped 90% of rows and was 8.70x faster. This fixed-slot
path only supports at most 256 numeric groups; arbitrary strings and high-cardinality groups need a
different representation.

#### Nullable sparse-u32 group-by with a bounded result

When keys span the full `u32` range but the selected result still contains relatively few distinct
keys, Worker-local SIMD fingerprint tables avoid constructing JS `Map<number, ...>` entries per row.
A byte validity column supplies null semantics without JS values.

```ts
import { SparseU32GroupByQuery } from "@mizchi/jsimd-olap/sparse-group-by-u32";

async function aggregateSparse(
  filter: Int32Array,
  keys: Uint32Array,
  values: Int32Array,
  validities: Uint8Array,
) {
  await using query = await SparseU32GroupByQuery.create(
    { filter, keys, values, validities },
    { capacity: 4_096, workerCount: 8, pageRows: 65_536 },
  );
  return await query.aggregateBetween(1_000, 2_000);
}
```

With 2,048 output keys this was 3.84x faster than threaded DuckDB. Capacity is fixed up front, so
this is not a replacement for an unbounded general-purpose SQL hash aggregation.

This approach is unlikely to win when the executor is initialized for only one small query, only a
few pages survive pruning, input must first be decoded from Arrow or copied from storage, the query
returns most input rows, or the workload needs general joins, sorting, window functions, strings, or
dynamic SQL. Worker dispatch also has a fixed cost. The physical planner therefore selects direct
SIMD for small surviving workloads and persistent Workers only when their estimated parallel gain
pays for dispatch.
