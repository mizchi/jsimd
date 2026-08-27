# Multithread vector search

> [!WARNING]
> This is an experimental implementation, not a production-ready search API. Worker scheduling,
> duplicated resident storage, and result merging are substantial overheads: the recorded benchmark
> is slower than one Worker at 32K vectors, roughly equal at 131K, and only about 2.1x faster at
> 262K–524K. Treat it as an exploration of where shared-memory SIMD sharding breaks even.

This example shards an exact squared-L2 `BlockedVectorArray` across Web Workers. Each Worker copies
only its assigned rows into a private Wasm SIMD index during construction. Repeated queries and
result publication use one shared `WebAssembly.Memory`:

```text
shared Float32 dataset
  ├─ Worker 0: SIMD index for shard 0
  ├─ Worker 1: SIMD index for shard 1
  ├─ Worker 2: SIMD index for shard 2
  └─ Worker 3: SIMD index for shard 3

shared query → per-Worker SPSC notification → local top-k
             → shared candidate slots → global workers × k merge
```

Run the browser example with Vite so the required COOP/COEP headers are present:

```sh
pnpm exec vite examples/multithread-vector-search
```

Run the repeatable Deno benchmark with:

```sh
pnpm bench:example:multithread-vector-search
```

The public lifecycle uses `await using`:

```ts
await using search = await MultithreadVectorSearch.create(values, count, dimensions, {
  workerCount: 4,
  k: 10,
});

const { ids, distances } = await search.search(query);
```

Worker startup and index construction copy each vector exactly once into one Worker's private Wasm
memory. They are setup costs and should be amortized over repeated queries. This compact example
retains the source dataset in shared memory for its full lifetime, so peak resident memory includes
both that source and the private blocked indexes.

The hot path transfers no vectors through `postMessage`. SPSC rings publish one scalar query epoch,
Workers read the shared query, and each writes at most `k` IDs and distances. The coordinator sorts
only `workerCount × k` candidates. Searches are deliberately sequential because all Workers share
one query and one result generation.

This is useful for medium-to-large resident indexes and repeated queries. For small indexes,
one-shot queries, or excessive Worker counts, startup, scheduling, and candidate merging can make a
single Worker or `postMessage` faster. The test compares three repeated queries against a stable
scalar full scan and covers `k` larger than individual shard sizes.

## Recorded trade-off

Apple M5 / Deno 2.6.4, 128 dimensions, exact squared L2, top 10, four Workers, 20 resident queries:

| vectors | single build | four-Worker build | single query | four-Worker query | query result |
| ------: | -----------: | ----------------: | -----------: | ----------------: | :----------- |
|  32,768 |     18.64 ms |         121.55 ms |      0.81 ms |           2.50 ms | 3.09x slower |
| 131,072 |     61.74 ms |         126.68 ms |      2.40 ms |           2.44 ms | parity       |
| 262,144 |    132.53 ms |         150.34 ms |      5.43 ms |           2.51 ms | 2.16x faster |
| 524,288 |    253.66 ms |         288.76 ms |     10.53 ms |           5.01 ms | 2.10x faster |

Construction includes Worker startup and copying each shard into its Worker's private Wasm index.
The multi-Worker path is therefore a loss for 32K vectors and requires repeated queries to amortize
setup. The committed raw result is in `benchmarks/baseline.json`.

The isolated Vite 8.2 production build emits about 14.1 kB gzip of JavaScript across the coordinator
and Worker chunks, plus 0.30 kB gzip shared-memory Wasm and 0.92 kB gzip vector-search Wasm. Both
kernels are independently emitted; unrelated jsimd Wasm assets are absent.
