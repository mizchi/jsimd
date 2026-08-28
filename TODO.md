# Implementation TODO

This file contains only workspace organization, release work, future experiments, and admission
decisions. Completed APIs, algorithms, benchmark results, and implementation history belong in the
README owned by each package or implementation. Experimental evidence stays under
`experiments/<name>/`.

## Workspace organization

The repository has four distinct ownership levels:

- `packages/jsimd`: published low-level SIMD kernels and Wasm-resident data structures;
- `packages/shared`: published SharedArrayBuffer and Web Worker primitives;
- `packages/columnar`: experimental typed storage and query execution built on low-level packages;
- `packages/bench`: private benchmark schema, runners, and build-budget checks.

`examples/` contains user-facing integrations. `experiments/` contains admission evidence and
rejected or not-yet-stable prototypes; production packages must never depend on either directory.

- [ ] Move the shared-memory implementation, WAT, tests, and documentation from
      `packages/jsimd/src/shared-buffer` into `packages/shared`; retain the old jsimd subpath only
      as an explicitly versioned compatibility export.
- [ ] Give `packages/columnar` ownership of its column kernel and remove the ambiguous overlap with
      `@mizchi/jsimd/columnar` once its low-level dependency boundary is stable.
- [ ] Move build-only tree-shake fixtures under their owning package. Keep only runnable,
      user-facing integrations under `examples/`.
- [ ] Replace source-relative cross-package imports in experiments and examples with workspace
      package imports where doing so still permits Worker module loading.
- [ ] Generate or validate package exports, Deno exports, WAT build entries, declarations, README
      inclusion, Wasm assets, and isolated fixtures from one release manifest.

## Experiment priority

An experiment does not become a package export merely because its isolated kernel is fast. It must
win an end-to-end representative workload after construction, data conversion, JS/Wasm or GPU
boundaries, output materialization, scheduling, and disposal.

### P1: parallel OLAP and storage

The physical execution hypothesis is recorded in
[`experiments/parallel-columnar-query/OLAP_DESIGN.md`](./experiments/parallel-columnar-query/OLAP_DESIGN.md).
Keep low-level shared-memory ABIs and kernels here; move a schema DSL, planner, catalog, and
product-facing query engine to a separate repository once the boundary is stable.

- [x] Compose row-group pruning, filter, count/sum/min/max, low-cardinality group-by, and
      partial-result reduction over immutable pages.
- [x] Benchmark TPC-H Q1/Q6-shaped kernels and log filter/group-by against optimized JavaScript,
      default DuckDB-Wasm, and a reproducible threaded DuckDB-Wasm build.
  - [x] Record Q1/Q6-shaped JavaScript, direct SIMD, persistent Worker, DuckDB `eh`, and DuckDB
        `coi` comparisons.
  - [x] Add the page-pruned log filter/group-by workload before closing this item.
- [x] Add string/null handling, schema evolution, and bounded host+Wasm cache accounting to the
      columnar schema experiment before considering extraction.
- [x] Run real-browser IndexedDB cold/warm restoration benchmarks; do not infer them from the Deno
      IndexedDB implementation.
- [ ] Replace whole-column double buffering with page-versioned publication if snapshot memory
      amplification becomes the limiting cost.

### P2: hybrid and vector search

The shared selection-mask and binary-rerank work remains under
[`experiments/parallel-hybrid-query`](./experiments/parallel-hybrid-query/README.md).

- [x] Define a representative embedding distribution before testing learned or rotated binary
      quantization. Dense recall in the current sign-bit experiment is insufficient.
- [x] Evaluate PDX block selection or dimension pruning only with a workload that can avoid enough
      resident reads to repay its metadata and branch cost.
- [ ] Add cancellation, Worker restart, and index replacement only if the experiment graduates into
      a reusable query-engine component.
- [ ] Investigate a GPU hybrid pipeline only after the WebGPU batch crossover is reproduced in a
      browser; do not add a GPU path for single-query latency.

### P3: shared-memory collections

Concurrent design follows four distinct contracts:

- `Atomic<T>`: linearizable scalar point updates
- `Sharded<T>`: one writer owns each shard
- `Striped<T>`: worker-local mutation followed by bulk reduction
- `Snapshot<T>`: immutable versions published atomically

Wasm has no atomic `v128` operations, so point mutation remains scalar and phase-local bulk work
uses SIMD.

- [ ] Evaluate concurrent Bloom filters as Worker-local filters plus SIMD OR. Atomic OR with
      concurrent queries must not silently promise snapshot consistency.
- [ ] Evaluate `ShardedHashMap` with one mutex per shard and the existing fingerprint table.
- [ ] Evaluate `StripedRoaringBitmap`, `ConcurrentSplitBlockBloomFilter`, `MultiQueuePriorityQueue`,
      and `ConcurrentAppendLog` only on representative workloads.
- [ ] Add `RwLock`, `Condvar`, `Semaphore`, or `OnceCell` only when a concrete consumer needs one.
- [ ] Add `EpochDomain` only when locks, barriers, or bounded snapshot slots cannot safely reclaim
      storage.
- [ ] Do not start with a fully lock-free hash map; compare against the best sharded JavaScript or
      shared-memory baseline first.

### P4: conditional data-structure candidates

- [ ] `RangeFilterU32`: test only when ZoneMap false positives cause measurable page reads.
- [ ] `DijkstraCsrGraph`: extend the recorded 1.16-1.45x grid win to broader weighted graph
      distributions before admission.
- [ ] `BitmapGridAStar`: investigate only for barrier-heavy maps; open grids already lost to the
      JavaScript baseline.
- [ ] `MortonSpatialIndex`: define an immutable spatial/tile lookup workload and compare with a
      sorted typed-array index.
- [ ] `UltraLogLog`: compare merge and estimation against an optimized JavaScript sketch, including
      hashing cost.
- [ ] `SimdOrderedIndex` and semiring graph kernels: admit only after a layout-level workload wins.

Do not add names merely for symmetry. `SimdFloat32Array`, `SimdInt32Vector`, and a standalone
`BitVector` remain reserved until they have a distinct measured workload that existing typed arrays,
`f32-vector`, `i32-array`, or `rank-select-bit-vector` do not already cover.

### P5: experiment infrastructure

- [x] Add a reusable browser benchmark harness that records runtime, adapter/CPU, warmup, sample
      count, input shape, end-to-end latency, and output correctness in one result format.
- [x] Add comparison helpers for resident, construction-inclusive, and materialization-inclusive
      workloads so new experiments do not accidentally compare different boundaries.
- [x] Add a benchmark-result schema check and keep recorded JSON colocated with each experiment.
- [x] Automate detection of regressions in gzip bundle size and previously admitted primary
      workloads without treating noisy microbenchmark changes as release failures.

### P6: WebGPU crossover and scheduling

GPU optimization is intentionally deferred until the higher-priority Wasm SIMD, OLAP, vector, and
shared-memory experiments have stable workloads. The existing exact squared-L2 baseline remains as
evidence under [`experiments/webgpu-vector-search`](./experiments/webgpu-vector-search/README.md).
On Apple M5 / Deno 2.6.4, single queries and upload-per-query never beat Wasm SIMD. A resident index
first crossed narrowly at 262,144 rows x 128 dimensions x four batched queries (1.06x), reached
2.08x at 65,536 rows x 128 dimensions x 64 queries, and reached 3.08x on the largest batch. Chromium
152 moved the crossover much lower: the resident GPU won at 65,536 rows for one query and was 2.30x
faster than the persistent four-Worker index at 262,144 rows x 128 dimensions x 64 queries. The
implementation remains private to the experiment until another adapter/runtime reproduces the
result.

- [x] Reproduce the complete size/batch matrix in Chromium and record adapter/runtime identity plus
      raw sample variance.
- [x] Implement a ring of staging/readback buffers and measure multiple in-flight batches.
- [x] Compare against the persistent multi-Worker SIMD index, not only single-threaded
      `BlockedVectorArray`.
- [x] Measure whether command reuse, fewer submissions, or a parallel workgroup top-k materially
      lowers the current boundary.
- [x] Keep the implementation experimental: Chromium wins after scheduling/readback on Apple M5, but
      one adapter/runtime is not enough evidence for a package export.

## Maintenance

- [x] Split `packages/jsimd/mod_test.ts` coverage into colocated
      `packages/jsimd/src/<name>/*_test.ts` files without shipping tests in the npm artifact.
- [x] Add a small release manifest test that compares `src` public directories, package exports,
      generated declarations, README files, WAT sources, and emitted Wasm assets.
- [ ] Test each publishable package from its `pnpm pack` tarball in Node, Deno, TypeScript, and Vite
      as applicable, rather than relying only on workspace source resolution.
- [ ] Standardize repository metadata, runtime requirements, license inclusion, and independent
      versioning across public package manifests.
- [ ] Add an import-boundary check: low-level packages may not depend on higher-level packages,
      examples, or experiments.
- [ ] Keep isolated Vite fixtures for every public entrypoint and require exactly one expected Wasm
      asset per imported subpath.
- [ ] Refresh recorded build sizes and representative benchmarks only when implementation or
      toolchain changes can affect them.

## Rejected prototypes

Keep these as evidence, not package exports. Revisit one only with a materially different layout or
workload.

| prototype           | rejection evidence                                                  |
| :------------------ | :------------------------------------------------------------------ |
| `StaticMphfBytes`   | Lookup 2.26x and construction 94.8x slower than a pre-encoded `Set` |
| `SuccinctTrie`      | Exact lookup and prefix ranges lost to JavaScript                   |
| `StringInterner`    | Native `Map<string, u32>` won decoded-string point lookup           |
| `LoudsTree`         | Batched parent navigation was 6.70x slower than `Uint32Array`       |
| `PackedUint32Array` | Decode and gather lost to typed arrays                              |
| `PackedDeltaArray`  | FOR+BP128 unpack and queries lost to typed arrays/Stream VByte      |
| sparse-matrix BFS   | Direct JavaScript adjacency traversal was 1.70x faster              |
| `SimdPriorityQueue` | Point/batched queue workload was 0.75-0.76x JavaScript              |
| bitmap A* SIMD heap | Barrier maps were 0.62-0.63x the scalar Wasm heap                   |

## Admission and completion policy

- Keep mutable builders separate from frozen query representations when their layouts conflict.
- Design bulk operations before point conveniences and batch queries across the JS/Wasm boundary.
- Keep data resident for repeated operations and also measure copy-inclusive one-shot use.
- A slower point convenience is acceptable only when a separate primary bulk workload wins and the
  README documents the trade-off.
- Use `using` in every public owning-structure example.
- Keep each public entrypoint under `packages/jsimd/src/<name>/` with its README, WAT source, typed
  Wasm declaration, tests, benchmark, and isolated tree-shake fixture.
- Generate stripped Wasm with `wasm-tools`, validate the required SIMD/threads features, and keep
  generated `.wasm` files Git-ignored.
- Record benchmark sources, exact baselines, gzip bundle sizes, and slower cases in the feature
  README.
- Test exceptional cleanup, use-after-dispose, allocator reuse plateaus, and forced Worker
  termination where ownership crosses Workers.
