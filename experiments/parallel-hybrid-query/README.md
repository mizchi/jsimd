# Parallel hybrid query experiment

Status: experimental and not exported from `@mizchi/jsimd`.

This experiment defines the first shared selection-mask ABI between column filters and vector search
kernels. An i32 filter writes packed bits directly into shared Wasm memory. PDX64 Float32 and
fixed-width binary kernels consume those words without returning selected row IDs to JavaScript.

```text
shared i32 column
      -> SIMD range filter
      -> SharedSelectionMask generation
          |-> masked PDX64 squared-L2 top-1
          `-> masked binary Hamming top-1
      -> one small result
```

## Contract

`SharedSelectionMask` has a cache-line-aligned header, 128-bit-padded words, one exclusive writer,
and generation-checked readers. A mutation invalidates the published generation before changing any
word. `publish()` makes the next generation visible through an atomic store.

Publication does not provide concurrent copy-on-write snapshots. The coordinator must establish the
phase boundary through a task queue, barrier, or wait group and must not mutate a generation while a
downstream kernel is reading it. This matches the existing shared-memory rule: scalar atomics
publish ownership and epochs, while SIMD accesses immutable phase-local data.

## Run

```sh
just test-parallel-hybrid-query
```

The tests cover attachability, exclusive ownership, stale generations, SIMD/tail filtering, empty
selection, PDX64 search, binary Hamming search, and repeated fixed-storage reuse.

## Persistent Worker index

`ParallelHybridVectorIndex` copies a row-major `Float32Array` once into a shared PDX64 layout. Each
long-lived Worker owns a disjoint range of 64-row blocks, computes SIMD distances, keeps only its
local top-k, and sends that small result to the coordinator. The coordinator merges at most
`workerCount * k` pairs for the default filter-first plan.

```ts
await using index = await ParallelHybridVectorIndex.create(filters, vectors, dimensions, {
  workerCount: 4,
  maxK: 10,
});

const result = await index.searchBetween(query, 100, 200, { k: 10 });
```

The input index is immutable. Query vectors and mask generations are reused in fixed shared-memory
slots; full vectors and selected row IDs do not cross the Worker boundary.

## Recorded plan comparison

Apple Silicon, Deno 2.6.4, 65,536 rows x 64 dimensions, four persistent Workers, `k=10`:

| Selectivity | Filter-first | Exact vector-first |
| ----------: | -----------: | -----------------: |
|          1% |      0.52 ms |            5.75 ms |
|         10% |      0.21 ms |            1.90 ms |
|        100% |      0.56 ms |            0.62 ms |

Filter-first won at every recorded selectivity, so it is the default. The explicit vector-first plan
remains only as an experimental comparator. Its exact candidate expansion recomputes distance scores
and can return progressively larger local candidate lists, making it especially poor for sparse
predicates. There was no measured crossover to justify an automatic planner.

Run the comparison with:

```sh
just bench-parallel-hybrid-query
```

## Current limits

The SIMD kernel currently computes scores and top-1; Worker-local top-k selection uses a bounded
JavaScript heap over the packed mask and Wasm score buffer. A fused masked Wasm top-k kernel should
only replace it after direct measurement. The pool does not yet support index replacement,
cancellation, Worker restart, binary-index sharding, or browser-specific scheduling measurements.
