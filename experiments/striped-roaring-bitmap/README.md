# Striped Roaring bitmap experiment

Status: positive only for a large resident batch; not exported from any package.

This experiment asks whether persistent Workers can improve the already fast dense-container
`RoaringBitmap.andCardinality()` kernel. It models a query planner evaluating many independent
posting-list pairs at once. Each pair is assigned round-robin to one Worker, constructed once, and
kept resident in that Worker. A query dispatches one batch and returns one exact JavaScript-number
cardinality per pair.

```ts
import { StripedRoaringIntersectionBatch } from "./batch.ts";

await using batch = await StripedRoaringIntersectionBatch.create(pairs, {
  workerCount: 4,
});
const counts = new Float64Array(pairs.length);
await batch.intersectionCardinalitiesInto(counts);
```

This is deliberately not a point-mutable concurrent bitmap. Wasm has no atomic `v128` operations,
and the resident Roaring kernel is already much faster than Worker dispatch for a single set pair.

## Recorded result

Apple M5 / Deno 2.6.4, four persistent Workers, 16 dense bitmap containers per set, 10 warmups and
median of 11 samples with five operations per sample. Construction, input cloning, and Worker
startup are excluded; dispatch and returning every result count are included.

| resident pairs | serial Roaring | striped Workers | median result | p95 result   |
| -------------: | -------------: | --------------: | :------------ | :----------- |
|              1 |       0.011 ms |        0.031 ms | 2.77x slower  | 1.32x slower |
|             16 |       0.094 ms |        0.108 ms | 1.16x slower  | 1.56x slower |
|             64 |       0.379 ms |        0.197 ms | 1.92x faster  | 1.83x faster |

At 64 pairs, scanning the equivalent sorted `Uint32Array` inputs took 74.24 ms, but this is not the
admission baseline: the stronger serial baseline is the same resident Roaring implementation. Each
left set contains 149,808 values, each right set 95,328 values, and every pair has 13,632 matches.

## Admission decision

Do not add a public `StripedRoaringBitmap` collection yet:

- one pair is dominated by Worker dispatch, and 16 pairs still lose;
- 64 pairs improve both median and p95, but this is a query-batch crossover rather than evidence for
  point-level concurrency;
- inputs must already be partitionable into independent resident pairs; cloning and construction are
  intentionally outside the repeated-query boundary;
- the useful abstraction would be a query-engine batch scheduler, not a generally concurrent
  replacement for `RoaringBitmap`;
- a future planner can reuse this experiment if it has enough independent posting-list work and can
  choose the serial path below the measured crossover.

Raw samples are in
[`benchmarks/resident-intersection-batch.json`](./benchmarks/resident-intersection-batch.json).

```sh
just test-striped-roaring-bitmap
just bench-striped-roaring-bitmap
just bench-record-striped-roaring-bitmap
```
