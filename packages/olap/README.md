# `@mizchi/jsimd-olap`

Experimental SIMD and Web Worker execution engine for resident typed columns. It provides focused
analytical kernels rather than a SQL parser or a general database.

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

## Performance boundary

The intended case is repeated scans over large resident numeric columns, page-prunable predicates,
fused aggregates, and small result states. Recorded Chrome benchmarks against DuckDB-Wasm showed
3.84x to 23.66x lower warm-query latency for the equivalent specialized operations.

The isolated Vite fixture for `range-aggregate` produces one query Worker and two Wasm assets (the
shared runtime and OLAP kernels): 17.26 KiB JavaScript and 2.52 KiB Wasm gzip in total. The npm
tarball containing all three entrypoints is about 38.0 KiB compressed. Subpath exports are
intentional: importing `range-aggregate` does not emit the group-by Workers.

This package is unlikely to win when initialization is included in a one-shot query, only a few
pages survive, input must first be copied from storage, most rows must be materialized, or the query
requires general strings, joins, sorting, window functions, or dynamic SQL. DuckDB-Wasm remains the
appropriate comparison for a complete analytical SQL engine; these results do not claim equivalent
functionality.

The package is `0.x`: public types are intentional, but execution calibration and physical formats
may change before `1.0`.
