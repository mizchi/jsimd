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
local top-k in Wasm, and sends that small result to the coordinator. The coordinator merges at most
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

## Worker-local top-k

The default filter-first path keeps mask iteration, a bounded max-heap, and final heap sort inside
Wasm. The retained `selector: "javascript"` option is a benchmark reference, not the default.

65,536 rows x 64 dimensions, four Workers, 31 samples:

| Selectivity |   k | JavaScript heap | Wasm heap | Speedup |
| ----------: | --: | --------------: | --------: | ------: |
|          1% |   1 |         0.13 ms |   0.13 ms |   1.00x |
|          1% |  10 |         0.25 ms |   0.16 ms |   1.56x |
|          1% | 100 |         0.27 ms |   0.20 ms |   1.35x |
|         10% |   1 |         0.22 ms |   0.22 ms |   1.00x |
|         10% |  10 |         0.19 ms |   0.18 ms |   1.06x |
|         10% | 100 |         0.24 ms |   0.19 ms |   1.26x |
|        100% |   1 |         0.65 ms |   0.43 ms |   1.51x |
|        100% |  10 |         0.49 ms |   0.43 ms |   1.14x |
|        100% | 100 |         0.53 ms |   0.58 ms |   0.91x |

The Wasm selector wins or ties eight of nine recorded medians and wins every `k=10` workload. A
dense `k=100` query remains a documented slower case; callers experimenting with that workload can
select the JavaScript reference explicitly. Run `just bench-parallel-hybrid-topk` to reproduce the
matrix. Tail latency was noisier than the medians, including a slower recorded p95 for the 1%,
`k=10` Wasm case. The complete experimental kernel module is 1.36 kB gzip; it is not part of the
published package.

## Binary shortlist and exact rerank

Each Worker shard also stores one sign bit per Float32 dimension. An approximate query applies the
metadata mask first, keeps a bounded Hamming shortlist with XOR + popcount, then reranks only those
local IDs against the PDX64 Float32 vectors. `candidateMultiplier` is per Worker, so four Workers
with `k=10` and multiplier 4 rerank at most 160 candidates globally.

65,536 normalized vectors x 128 dimensions, four Workers, eight queries, `k=10`:

| Selectivity | Candidate multiplier |  Median | Speedup vs exact | Recall@10 |
| ----------: | -------------------: | ------: | ---------------: | --------: |
|          1% |                   2x | 0.11 ms |            1.37x |      0.83 |
|          1% |                   4x | 0.10 ms |            1.41x |      0.95 |
|          1% |                   8x | 0.11 ms |            1.36x |      1.00 |
|         10% |                   2x | 0.09 ms |            1.87x |      0.61 |
|         10% |                   4x | 0.09 ms |            1.76x |      0.79 |
|         10% |                   8x | 0.11 ms |            1.49x |      0.88 |
|        100% |                   2x | 0.14 ms |            3.87x |      0.45 |
|        100% |                   4x | 0.20 ms |            2.64x |      0.51 |
|        100% |                   8x | 0.23 ms |            2.33x |      0.65 |

This is useful as a selective metadata-filtered shortlist, not as a general ANN index. At 1%
selectivity, 4x candidates retained 0.95 recall with a 1.41x speedup and 8x reached full recorded
recall. Recall was inadequate for dense scans even though latency improved. The API therefore
requires an explicit candidate multiplier and never presents this path as exact. Run
`just bench-parallel-hybrid-binary` to reproduce the result.

## Current limits

The pool does not yet support index replacement, cancellation, Worker restart, learned/rotated
binary quantization, or browser-specific scheduling measurements. Exact vector-first expansion still
uses the JavaScript selector because its candidate count can grow beyond the configured result
`maxK`.
