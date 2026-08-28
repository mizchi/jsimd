# Reusable shared columnar selection

This admission experiment composes multiple resident `i32` range predicates into one
generation-checked `SharedSelectionMask`, then reuses the packed words for `count/sum/min/max` over
multiple measure columns. Predicate and aggregate kernels operate directly on one shared Wasm
memory; JavaScript receives only the aggregate states.

```ts
import { SharedI32SelectionPipeline } from "./pipeline.ts";

await using pipeline = await SharedI32SelectionPipeline.create([
  timestamp,
  category,
  price,
  quantity,
]);
const selection = pipeline.selectBetween([
  { column: 0, minimum: start, maximum: end },
  { column: 1, minimum: 3, maximum: 5 },
]);
const [priceState, quantityState] = selection.aggregateMany([2, 3]);
```

`selectBetween()` publishes a new generation and invalidates the previous selection. This is an
immutable phase boundary, not a concurrent mutable snapshot. The pipeline owns shared memory and
uses `await using`; the returned selection is a non-owning generation view.

## Recorded result

Apple M5 / Deno 2.6.4, 1,048,576 resident rows, two predicates, 124,392 selected rows (11.9%), 20
warmups and median of 21 samples with five operations per sample:

| measures | shared SIMD mask | fastest optimized JS | result            |
| -------: | ---------------: | -------------------: | :---------------- |
|        1 |          1.22 ms |              1.27 ms | SIMD 1.04x faster |
|        2 |          1.51 ms |              1.51 ms | parity            |
|        4 |          2.19 ms |              2.20 ms | parity            |
|        8 |          3.40 ms |              3.04 ms | SIMD 1.12x slower |

Both timings include two predicate scans, mask composition, and all requested aggregates. Resident
construction and row-ID materialization are excluded. The JavaScript comparison records both a fully
unrolled projection and a dynamic measure loop and uses the faster median for every width. Both fuse
predicates and measures into one indexed pass, accumulate exactly representable integer sums as
`Number`, and convert to `BigInt` once per result.

The current implementation should not be exported from `@mizchi/jsimd-olap`. Each masked aggregate
rescans all mask words and one complete measure column, while fused JavaScript skips measure loads
for rejected rows and amortizes predicate checks over every measure. After correcting the earlier
dynamic-only JS baseline, the packed mask has only a narrow one-measure lead, is at parity for two
and four, and becomes a bandwidth cost by eight measures at this selectivity.

This pipeline is not being adopted. The experiment remains as a reproducible negative result, but no
downstream-Worker variant or OLAP package export is planned from the current design. The shared
selection-mask primitive remains useful independently as a generation-checked handoff ABI.

Raw samples are in [`benchmarks/reusable-mask.json`](./benchmarks/reusable-mask.json).

```sh
just test-parallel-columnar-selection
just bench-parallel-columnar-selection
just bench-record-parallel-columnar-selection
```
