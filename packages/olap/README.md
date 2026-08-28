# `@mizchi/jsimd-olap`

Small, specialized OLAP kernels for browsers: the recorded `range-aggregate` Vite fixture is 20.08
KiB gzip in total (17.56 KiB JavaScript + 2.52 KiB Wasm). The package combines WebAssembly SIMD with
persistent Web Workers over resident typed columns, and stays small by providing focused analytical
operators rather than a SQL parser or a general database.

## Requirements

- Deno or Vite with ESM Wasm integration
- WebAssembly SIMD
- `SharedArrayBuffer` and Web Workers for parallel execution
- COOP/COEP cross-origin isolation when parallel execution is used in a browser

Node.js does not currently expose the browser-compatible global `Worker` used by this package. A
Node worker adapter is intentionally not part of `0.1.0`.

## Range aggregate

Keep the executor resident and issue multiple bulk queries. `auto` selects direct SIMD for a small
surviving page set and persistent Workers when parallel work is expected to repay dispatch.

```ts
import { I32AggregatePipeline } from "@mizchi/jsimd-olap/range-aggregate";

await using pipeline = await I32AggregatePipeline.create(values, {
  workerCount: 8,
  pageRows: 65_536,
});

const result = await pipeline.aggregateBetween(1_000, 2_000);
console.log(result.count, result.sum, result.plan.execution);
```

The predicate is the half-open interval `[minimum, maximum)`. A `SchemaEngine` snapshot can be used
without reconstructing one complete `Int32Array`:

```ts
import { I32AggregatePipeline } from "@mizchi/jsimd-olap/range-aggregate";

await using pipeline = await I32AggregatePipeline.createFromSchema(
  engine,
  "events",
  "timestamp",
  { workerCount: 8 },
);
const result = await pipeline.aggregateBetween(start, end);
```

## Low-cardinality group-by

This fixed-slot path accepts dense `u8` group IDs and computes `count/sum/min/max` per group.

```ts
import { I32GroupByU8Pipeline } from "@mizchi/jsimd-olap/group-by-u8";

await using pipeline = await I32GroupByU8Pipeline.create(
  { filter: timestamps, values, groups: categoryIds },
  { groupCount: 8, workerCount: 8, pageRows: 65_536 },
);
const result = await pipeline.aggregateBetween(start, end);
```

Both resident pipelines expose the same lifecycle controls. `replace()` atomically publishes a
same-shaped immutable snapshot, `cancelCurrent()` interrupts active Worker execution at a page
boundary, and `restartWorkers()` replaces the Worker pool without rebuilding the snapshot. Direct
single-thread execution is synchronous and therefore cannot be interrupted from JavaScript.

```ts
const generation = pipeline.replace({ filter, values, groups });
const pending = pipeline.aggregateBetween(start, end, { execution: "workers" });
pipeline.cancelCurrent();
try {
  await pending;
} catch (error) {
  if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
}
await pipeline.restartWorkers();
```

## Sparse-u32 group-by

Use the sparse path when keys cover the full `u32` range but the selected result has a bounded
number of distinct keys. `validities` contains one byte per row.

```ts
import { SparseU32GroupByQuery } from "@mizchi/jsimd-olap/sparse-group-by-u32";

await using query = await SparseU32GroupByQuery.create(
  { filter, keys, values, validities },
  { capacity: 4_096, workerCount: 8, pageRows: 65_536 },
);
const result = await query.aggregateBetween(1_000, 2_000);
```

The sparse query remains an immutable create/use/dispose object. Replacing its columns also changes
the bounded hash-table workload and may require a different capacity, so it does not pretend to
offer the same-shaped snapshot replacement contract.

## Stable u32 order

`RadixOrderU32` produces sorted keys and a stable row-ID permutation. It consumes manifest-only
facts from `SchemaEngine`, so sorted, narrow-range, and legacy columns keep a JavaScript builtin
path while large unordered columns use four-pass Wasm radix sorting.

```ts
import { RadixOrderU32 } from "@mizchi/jsimd-olap/radix-order-u32";

const facts = await engine.readU32OrderMetadata("events", "entityId");
const keys = (await engine.query("events").select("entityId").execute()).columns.entityId;
const sortedKeys = new Uint32Array(keys.length);
const rowIds = new Uint32Array(keys.length);

await using order = await RadixOrderU32.create(keys.length);
const strategy = order.orderInto(keys, sortedKeys, rowIds, facts);
```

The ordering facts are persisted during ingestion and updated per immutable row group. Reading them
does not load column payloads. Existing manifests without these optional facts safely use the native
packed-u64 fallback. The operator is specialized to non-nullable unsigned keys; descending,
nullable, multi-column, and arbitrary-payload ordering are not implied.

On the recorded Apple M5 / Deno 2.6.4 benchmark at 1,048,576 rows, metadata-backed ordering was
2.18x faster than packed-u64 JavaScript on uniform random keys and 2.01x faster on radix-partitioned
keys. It stayed near parity on already sorted keys (1.03x) and low-cardinality keys (0.99x) by
selecting direct-copy or native-sort paths. Ingestion-time metadata construction is excluded from
these repeated resident-query measurements. Facts and keys must describe the same immutable table
generation.

## Performance boundary

The intended case is repeated scans over large resident numeric columns, page-prunable predicates,
fused aggregates, and small result states.

### DuckDB-Wasm comparison

The following table reports warm-query medians from cross-origin-isolated Chrome 152 on an Apple M5.
Each jsimd result uses the specialized physical operator equivalent to the DuckDB query. The speedup
compares eight persistent jsimd Workers with the faster of DuckDB-Wasm `eh` and `coi` for that
workload.

| workload                      | input                                  | jsimd direct | jsimd 8 Workers | DuckDB `eh` | DuckDB `coi` | speedup vs fastest DuckDB |
| :---------------------------- | :------------------------------------- | -----------: | --------------: | ----------: | -----------: | ------------------------: |
| Q6-shaped range `count + sum` | 33.6M rows, 25% selected               |      4.10 ms |         1.25 ms |    29.58 ms |     61.17 ms |                    23.66x |
| Q1-shaped dense group-by      | 16.8M rows, 8 groups, 50% selected     |     14.64 ms |         3.29 ms |    51.02 ms |     54.80 ms |                    15.51x |
| ZoneMap-pruned log group-by   | 16.8M rows, 8 groups, 10% selected     |      2.62 ms |        0.675 ms |    11.02 ms |      5.88 ms |                     8.70x |
| Nullable sparse-u32 group-by  | 16.8M rows, 2,048 groups, 10% selected |     13.33 ms |         3.87 ms |    22.17 ms |     14.86 ms |                     3.84x |

These are repeated-query measurements over already constructed resident input: initialization,
Worker startup, and DuckDB table construction are excluded. Returned aggregate state is included,
including materializing and sorting all 2,048 groups in the sparse case. Five warmups precede the
median of 11 samples. The raw records are available for
[Q6](../../experiments/parallel-columnar-query/benchmarks/duckdb-browser.json),
[Q1](../../experiments/parallel-columnar-query/benchmarks/duckdb-browser-q1.json),
[the pruned log workload](../../experiments/parallel-columnar-query/benchmarks/duckdb-browser-logs.json),
and
[sparse grouping](../../experiments/parallel-columnar-query/benchmarks/duckdb-browser-sparse.json).

|                         | `@mizchi/jsimd-olap`                                                         | DuckDB-Wasm                                                             |
| :---------------------- | :--------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| Interface               | Typed, fixed-purpose TypeScript APIs                                         | SQL, relational tables, and Arrow integration                           |
| Current operations      | Range aggregate, dense/sparse group-by, stable u32 order                     | General filters, joins, grouping, sorting, windows, and SQL expressions |
| Execution               | Direct Wasm SIMD or persistent Web Workers selected by a physical cost model | Single-threaded `eh` or experimental threaded `coi` bundle              |
| Best fit                | Repeated scans over resident typed columns with small aggregate results      | General analytical queries and dynamic SQL                              |
| Recorded fixture assets | 17.56 KiB JavaScript + 2.52 KiB Wasm gzip for range aggregate                | 7.42-7.49 MiB Wasm + 186-356 KiB Worker JavaScript gzip                 |

The asset sizes are not feature-equivalent: DuckDB includes a complete analytical database while the
jsimd fixture includes only the imported kernels and runtime.

The isolated Vite fixture for `range-aggregate` produces one query Worker and two Wasm assets (the
shared runtime and OLAP kernels): 17.56 KiB JavaScript and 2.52 KiB Wasm gzip in total. The npm
tarball containing all four entrypoints is about 43.9 KiB compressed. The isolated `radix-order-u32`
fixture is 2.21 KiB gzip in total (1.94 KiB JavaScript + 0.27 KiB Wasm) and emits no Worker runtime.
Subpath exports are intentional: importing `range-aggregate` does not emit the group-by Workers,
while importing `radix-order-u32` does not emit any shared-memory runtime.

This package is unlikely to win when initialization is included in a one-shot query, only a few
pages survive, input must first be copied from storage, most rows must be materialized, or the query
requires general strings, joins, sorting, window functions, or dynamic SQL. DuckDB-Wasm remains the
appropriate comparison for a complete analytical SQL engine; these results do not claim equivalent
functionality.

The package is `0.x`: public types are intentional, but execution calibration and physical formats
may change before `1.0`.
