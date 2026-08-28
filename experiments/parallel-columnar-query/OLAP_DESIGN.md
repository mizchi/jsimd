# Experimental OLAP execution design

Status: physical-execution plan. Page-versioned row-group publication has graduated into the
experimental columnar package; the remaining operators still require an end-to-end benchmark against
optimized JavaScript and DuckDB-Wasm before admission.

## Motivation

The current experiment demonstrates a useful narrow boundary: persistent Workers can scan one
immutable, non-nullable i32 column with a hand-assembled SIMD count/sum kernel faster than both the
single-threaded and experimental threaded DuckDB-Wasm bundles. The result does not establish an
advantage for general analytical queries.

The next level of generality would be a typed physical execution substrate, not a SQL frontend.
DuckDB's execution engine moves horizontal slices of columns through operators as `DataChunk`s; its
vectors support physical representations such as flat, constant, and dictionary layouts. A jsimd
experiment should reuse the existing resident column, mask, hash, snapshot, and shared-memory
structures rather than duplicate them behind database-specific names.

Sources:

- [DuckDB internals overview](https://duckdb.org/docs/current/internals/overview)
- [DuckDB data chunks](https://duckdb.org/docs/current/clients/c/data_chunk)
- [DuckDB vectors](https://duckdb.org/docs/lts/clients/c/vector)
- [DuckDB aggregate states](https://github.com/duckdb/duckdb/blob/main/extension/core_functions/aggregate/README.md)

## Non-goals

- SQL parsing, binding, optimization, or a catalog
- transactions and MVCC
- arbitrary JavaScript values as keys
- general-purpose ART/B-tree indexes
- window functions, external sorting, or a spill manager before memory pressure is measured
- claiming that a specialized kernel is a complete DuckDB replacement

## Proposed physical structures

### 1. `ValidityMask`

Keep nullability distinct from query selection even if both use packed bits:

```text
ValidityMask  = which logical values exist
SelectionMask = which rows continue through the current pipeline
```

Required bulk behavior is validity-aware filtering and aggregation without materializing row IDs.

### 2. `PhysicalVector` and `ExecutionChunk`

An `ExecutionChunk` is a non-owning horizontal view over equally sized column vectors and one
resident selection mask. Storage pages remain larger and independently versioned.

```ts
type PhysicalVector =
  | FlatVector
  | ConstantVector
  | DictionaryVector
  | AdaptivePageVector
  | NullableVector;

interface ExecutionChunk {
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly columns: readonly PhysicalVector[];
  readonly selection: SelectionMask;
}
```

Existing adaptive i32/u32/u8 columns and `SelectionMask` should supply the first implementations.
The abstraction is only useful if operators can scan encoded vectors directly; a mandatory decode
into flat vectors would erase the current advantage.

The first narrow implementation is now `ExecutionChunkI32`: immutable page descriptors hold row
ranges and i32 ZoneMaps, while `PhysicalExecutionPlanner` remains a pure cost comparison separated
from the resident `I32AggregatePipeline`. The pipeline returns the chosen direct/Worker mode,
surviving-page estimate, estimated costs, and reason with the aggregate result. On the recorded Deno
runtime, direct count+sum won clearly through 128 surviving 65,536-row pages, 256 pages were within
1%, and eight Workers won 2.01x at 512 pages. The default is therefore deliberately conservative.
`SchemaEngine.readI32SnapshotPages()` and `I32AggregatePipeline.createFromSchema()` now provide the
first storage-to-execution bridge. One manifest generation is pinned while its immutable pages are
read; the path validates `AdaptiveI32Column` snapshots without creating resident columns, copies
only encoded constant/FOR/raw payloads into shared Wasm memory, and runs FOR decoding inside the
SIMD aggregate kernel. The SchemaEngine cache remains empty. IndexedDB and filesystem backends
cannot provide true zero-copy `SharedArrayBuffer` reads, so one encoded payload copy remains
explicit.

The first encoding-sensitive calibration showed why physical representation belongs in the chunk
contract. Across 8,388,608 rows, direct constant aggregation took 1.78 ms because each page reduces
in O(1), direct raw took 2.66 ms, and direct FOR-8 took 11.07 ms. Eight Workers took 2.51, 2.50, and
3.78 ms respectively. `PhysicalExecutionPlanner` therefore models descriptor/call overhead plus
constant/raw/FOR row costs instead of multiplying one universal page cost.

Low-cardinality u8 group-by now has an independent Deno profile and physical pipeline. With eight
groups and 65,536-row raw pages, direct execution won through 16 surviving pages (1.84 ms versus
2.31 ms), while Workers won from 32 pages (2.31 ms versus 3.87 ms) and reached 4.50x at 512 pages.
The calibrated planner selected the fastest mode in all eight tested cases. This profile
deliberately does not claim to cover sparse hash grouping or encoded multi-column input.

Chromium 152 required a distinct runtime profile. Its persistent-Worker dispatch was approximately
0.07-0.10 ms rather than Deno's approximately 2.3 ms, moving the raw 65,536-row-page crossover from
roughly 256/512 pages to 4/16 pages. Adaptive 256-row pages also required a Worker-only page-claim
term: constant pages were 1.54 ms direct versus 2.11 ms parallel, FOR-8 was 10.46 ms versus 2.92 ms,
and raw was tied at 2.26/2.28 ms. Modeling dispatch alone incorrectly parallelized constant and raw
small pages; the fitted page-claim cost selected all three encoding modes and all eight raw page
counts in the recorded Chrome runs.

This is still not the proposed multi-column `ExecutionChunk`: the bridge supports only one
non-nullable i32 vector, eagerly stages that vector's encoded pages, and has no shared validity or
selection-mask pipeline.

### 3. `AggregateStateBlock`

Use structure-of-arrays state for count, sum, min, max, null count, and the sum/count pair needed by
average. Workers update private state and combine it only after a barrier. Aggregate state should
remain resident and use scaled integers before adding a general decimal contract.

The experimental implementation now stores `count/nullCount/sum/min/max` in one cache-line-aligned
SoA block. It derives average from sum/count, uses neutral extrema for empty groups, and combines
four groups per Wasm SIMD iteration with a scalar tail. The parallel u8 group-by uses this block for
both Worker-local output and final reduction. The scan remains non-nullable; null-count production
will be connected when nullable physical vectors reach this execution path. Eight groups are too few
to isolate a meaningful merge speedup, so public extraction depends on a higher-cardinality
benchmark.

### 4. `LocalGroupHashTableU32`

Start with u8/u16/u32 or packed small-integer keys and dictionary IDs. Reuse the existing SIMD
fingerprint/hash kernels, but store group IDs and aggregate-state indices instead of JavaScript
values.

```text
Worker-local group tables
        -> hash/radix partitions
        -> ownership-based parallel merge
        -> aggregate-state combine
```

Do not begin with a concurrently mutated global table.

The experimental `LocalGroupHashTableU32` now uses a 16-byte SIMD fingerprint probe group, complete
u32 keys, and nullable i32 `count/nullCount/sum/min/max` state in shared memory. Each persistent
Worker builds one exclusive table, then owns one radix-partition output and merges that partition
from every partial table after the barrier. No table is concurrently mutated. At 1,048,576 rows and
4,096 groups this was 4.40x faster than JavaScript `Map`, including result materialization. At 256
groups single-thread Wasm was effectively tied with `Map`, so a planner must retain the dense
fixed-array path for small known domains. A second immutable query path applies i32 ZoneMaps and a
four-lane SIMD range predicate before grouping. At 16,777,216 rows, 2,048 sparse u32 groups, and 10%
selectivity, 8 persistent Workers took 3.87 ms versus 22.17 ms for DuckDB-Wasm `eh` and 14.86 ms for
the explicitly threaded `coi` bundle, including 2,048-state materialization. This admits the
low-level table and merge ABI as a useful physical-operator experiment; planner and schema APIs
still belong outside this repository.

### 5. `PartitionedHashJoinTable`

The minimum join substrate consists of resident hash values, u32 row IDs, radix partition offsets,
duplicate-key chains, and a caller-owned output buffer of matching row-ID pairs. An optional blocked
Bloom filter may reject absent probe keys. Each partition should have one build/probe owner.

The experimental `PartitionedHashJoinTableU32` now implements that physical ABI with independent
Swiss-style control groups and Bloom blocks per radix partition. Build keys, duplicate chains, and
row IDs stay resident in shared Wasm memory. A direct probe or four persistent Workers materialize
exact row-ID pairs into caller-owned buffers in deterministic probe-major/build-input order. Worker
output shards are disjoint, so an immutable table needs no atomic operation in the probe loop.

On Apple M5 with 131,072 build rows, 65,536 distinct keys, two build rows per key, and 1,048,576
probe rows, the four-Worker path was faster than both JavaScript `Map` and direct Wasm at every
recorded hit ratio. The blocked Bloom prefilter improved the four-Worker median from 4.36 ms to 3.95
ms when 90% of probes missed. At 90% hits it increased the median from 6.43 ms to 7.75 ms. Therefore
Bloom selection is a planner decision based on expected misses, not a default table feature. The
benchmark includes exact pair materialization but excludes table build and Worker startup; raw
samples and p95 values are retained in `benchmarks/partitioned-hash-join.json`.

### 6. `DictionaryStringColumn`

Compose the existing byte-key hash table and compressed string table so execution sees only u32
dictionary IDs. String decoding stays outside scan, group-by, and join hot paths.

### 7. `VersionedRowGroup`

Replace whole-column double buffering with immutable page handles. A new generation reuses unchanged
pages and allocates only replacements; reader guards delay page reuse. This is the bridge to the
existing memory, IndexedDB, and filesystem page backends.

`SchemaEngine.updateRowGroups()` now provides this contract for engines sharing one `PageBackend`
object. It publishes the new manifest after writing replacement pages, retains unchanged page keys,
and delays vacuum while another engine pins an observed generation. Cross-instance filesystem,
IndexedDB connection, and multi-tab coordination remain outside that in-process guarantee.

### 8. `RadixSortBlock`

Only u32/u64 keys and row IDs are initially in scope. This supports partitioning, deterministic
group merge, dictionary construction, and later order/top-k experiments without a generic
comparison-sort API.

## Possible evaluation order

This is a hypothesis list, not an implementation order:

1. `ValidityMask`
2. `PhysicalVector` plus `ExecutionChunk`
3. `AggregateStateBlock`
4. `LocalGroupHashTableU32`
5. parallel low-cardinality group-by
6. `PartitionedHashJoinTable`
7. `DictionaryStringColumn`
8. `VersionedRowGroup`
9. `RadixSortBlock`

The first admission workloads would be a TPC-H Q6-shaped multi-column filter/expression/sum and a
Q1-shaped packed-key group-by with multiple aggregates. Both must report copy-inclusive setup,
resident warm execution, worker scaling, null handling, memory amplification, and bundled size.

## Relationship to current code

| Proposed role             | Existing reusable component                      |
| :------------------------ | :----------------------------------------------- |
| query selection           | `SelectionMask`                                  |
| encoded numeric vectors   | adaptive i32/u32/u8 columns                      |
| immutable publication     | `VersionedBuffer`                                |
| row-group pruning         | parallel columnar page descriptors and zone maps |
| worker-local scheduling   | SPSC rings, wait group, atomic page claims       |
| numeric/fixed-key hashing | flat hash and fingerprint-group kernels          |
| dictionary bytes          | `CompressedStringTable`, `ByteKeyFlatHashMapU32` |
| persisted pages           | columnar schema-engine page backends             |

The design should move to a separate repository if it grows a planner, catalog, schema lifecycle, or
product-facing query API. jsimd should retain only independently useful low-level structures and
their benchmark evidence.
