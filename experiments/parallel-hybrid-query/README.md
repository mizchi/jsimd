# Parallel hybrid query experiment

Status: experimental and not exported from `@mizchi/jsimd`.

This experiment uses the shared runtime's generation-checked selection-mask ABI between column
filters and vector search kernels. An i32 filter writes packed bits directly into shared Wasm
memory. PDX64 Float32 and fixed-width binary kernels consume those words without returning selected
row IDs to JavaScript.

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
`k=10` Wasm case. The complete experimental kernel module is 1.70 kB gzip; it is not part of the
published package.

## Binary shortlist and exact rerank

Each Worker shard also stores one sign bit per Float32 dimension. An approximate query applies the
metadata mask first, keeps a bounded Hamming shortlist with XOR + popcount, then reranks only those
local IDs against the PDX64 Float32 vectors. `candidateMultiplier` is per Worker, so four Workers
with `k=10` and multiplier 4 rerank at most 160 candidates globally.

The original benchmark only covered normalized isotropic random vectors, which are unusually
friendly to zero-threshold sign bits. The recorded matrix now uses three deterministic synthetic
geometry probes. They are not substitutes for a domain corpus:

- `isotropic-unit`: a balanced, sign-friendly control;
- `clustered-anisotropic`: local clusters with concentrated dimension variance;
- `mean-shifted`: a failure probe where most zero-threshold sign bits agree.

65,536 normalized vectors x 128 dimensions, four Workers, eight queries, `k=10`, and a 4x candidate
multiplier:

| Distribution          | Sign-one rate | Dominant variance | Selectivity |  Median | Speedup vs exact | Recall@10 |
| --------------------- | ------------: | ----------------: | ----------: | ------: | ---------------: | --------: |
| isotropic-unit        |          0.50 |              0.01 |          1% | 0.42 ms |            1.28x |      0.90 |
|                       |               |                   |         10% | 0.35 ms |            1.65x |      0.68 |
|                       |               |                   |        100% | 0.46 ms |            3.49x |      0.49 |
| clustered-anisotropic |          0.50 |              0.05 |          1% | 0.24 ms |            2.73x |      0.79 |
|                       |               |                   |         10% | 0.30 ms |            1.73x |      1.00 |
|                       |               |                   |        100% | 0.49 ms |            2.55x |      0.83 |
| mean-shifted          |          0.88 |              0.03 |          1% | 0.34 ms |            0.89x |      0.60 |
|                       |               |                   |         10% | 0.22 ms |            2.28x |      0.35 |
|                       |               |                   |        100% | 0.39 ms |            2.77x |      0.21 |

Raw sign-bit recall depends on embedding geometry. The mean-shifted dense workload is 2.77x faster
but retains only 0.21 Recall@10, so latency alone cannot qualify this path. Anisotropy and variance
concentration also occur in learned embeddings, while distance-preserving binary embedding methods
normally add a learned or structured transform instead of relying on raw signs
([anisotropy study](https://arxiv.org/abs/2606.29571),
[structured binary embedding](https://arxiv.org/abs/1801.08639)). This experiment therefore remains
an explicit approximate option; learned or rotated quantization should wait for a representative
domain corpus.

The complete 2x/4x/8x matrix is in
[`benchmarks/binary-rerank.json`](./benchmarks/binary-rerank.json). Run
`pnpm bench:record:parallel-hybrid-binary` to regenerate it. Recall is deterministic for the fixed
workloads; the sub-millisecond timing values are exploratory and show more run-to-run noise.

## Exact PDX64 block pruning

The experimental exact selector stores a Float32 minimum and maximum for every dimension of each
64-vector PDX block. It scans those bounds first and skips a block when its squared-L2 lower bound
is already worse than the current top-k heap. The bound uses the same Float32 dimension order as the
full distance, and the tests require identical IDs and distances across block tails and randomized
inputs.

65,536 normalized vectors x 128 dimensions, eight queries, and `k=10`:

| Physical layout   | Bound metadata | Evaluated blocks | Full PDX | Block-pruned | Speedup |
| ----------------- | -------------: | ---------------: | -------: | -----------: | ------: |
| clustered blocks  |          3.13% |            5.70% |  1.31 ms |      0.60 ms |   2.19x |
| shuffled clusters |          3.13% |          100.00% |  1.32 ms |      1.32 ms |   1.00x |

The result is layout-dependent. Tight physical clusters avoid 94.3% of resident vector blocks, but
metadata reads and branching limit the end-to-end gain to 2.19x. Once cluster members are spread
across blocks, the bounds overlap, no vector reads are avoided, and the recorded speedup disappears.
The 1 MiB bounds also add 3.13% to the 32 MiB vector payload, while index construction took about
70–85 ms in this run. This is therefore useful only when ingestion can preserve locality; it should
not be enabled as generic PDX metadata.

The result is recorded in
[`benchmarks/pdx-block-pruning.json`](./benchmarks/pdx-block-pruning.json). Run
`pnpm bench:record:parallel-hybrid-pdx-pruning` to reproduce it. The implementation remains an
experiment and is not a package export.

## Current limits

The pool does not yet support index replacement, cancellation, Worker restart, learned/rotated
binary quantization, or browser-specific scheduling measurements. Exact vector-first expansion still
uses the JavaScript selector because its candidate count can grow beyond the configured result
`maxK`.
