# Implementation TODO

This file contains only workspace organization, release work, future experiments, and admission
decisions. Completed APIs, algorithms, benchmark results, and implementation history belong in the
README owned by each package or implementation. Experimental evidence stays under
`experiments/<name>/`. Cross-cutting lessons that change future admission decisions are summarized
here.

## Workspace organization

The repository has five distinct ownership levels:

- `packages/jsimd`: published low-level SIMD kernels and Wasm-resident data structures;
- `packages/shared`: published SharedArrayBuffer and Web Worker primitives;
- `packages/columnar`: experimental typed storage and query execution built on low-level packages;
- `packages/olap`: experimental SIMD and persistent-Worker analytical execution over resident typed
  columns;
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

### Weighted next implementation order

Feature work is ranked by end-to-end evidence (35%), fit with resident bulk execution (25%), reuse
of measured primitives (20%), resistance to a strong JavaScript builtin baseline (10%), and
implementation/bundle cost (10%). A score authorizes only the first admission experiment, not a
package export.

| rank | candidate                                       | weight | first admission workload                                                      |
| ---: | :---------------------------------------------- | -----: | :---------------------------------------------------------------------------- |
|    1 | resident WebGPU hybrid vector pipeline          |     55 | Batched resident query on a second adapter/runtime; never single-query upload |
|    2 | `MortonSpatialIndex`                            |     54 | Frozen batched tile/range lookup versus sorted typed-array intervals          |
|    3 | `RangeFilterU32`                                |     48 | Storage workload where measured ZoneMap false positives cause page reads      |
|    4 | `DijkstraCsrGraph`                              |     44 | Weighted graph families beyond the existing favorable grid                    |
|    5 | `ShardedHashMap`                                |     31 | Contended batched phases versus per-Worker/native `Map`, not point lookup     |
|    6 | `MultiQueuePriorityQueue`                       |     22 | Only a scheduler workload that amortizes the already-rejected point queue     |
|    7 | extra locks or `EpochDomain` without a consumer |      5 | Do not implement speculatively                                                |

### Recorded admission lessons

`RadixOrderU32` demonstrated that physical metadata can matter more than another kernel. Persisted
per-row-group ordering facts removed runtime distribution discovery: at 1M rows the public stable
key-plus-row-ID operator was 2.18x faster than the strongest packed-u64 JavaScript baseline on
uniform random input and 2.01x faster on radix-partitioned input, while remaining at parity on
sorted (1.03x) and 256-value-cardinality (0.99x) inputs. It is exported from
`@mizchi/jsimd-olap/radix-order-u32`; generic key-only u32/u64 sorting remains experimental because
its unconditional API includes losing distributions.

Persistent Workers need enough independent bulk work, not merely fast isolated halves.
`StripedRoaringBitmap` was 2.77x slower for one resident dense intersection pair and 1.16x slower
for 16 pairs, but a 64-pair batch improved median throughput 1.92x and p95 1.83x. Worker-local Bloom
rebuilt 1M keys 2.46x faster, yet refresh plus exact lookup improved only 1.08x at 90% misses and
was 1.25-1.28x slower at higher hit rates. Keep both as scheduler and selectivity evidence rather
than public concurrent collections.

`UltraLogLogU32` was admitted because both expensive phases match the repository: bulk hashing is a
regular resident loop and independent compact states can be reduced with SIMD. On Apple M5 / Deno
2.6.4 at precision 14, 1M `u32` values were 2.16x faster than optimized JavaScript through single
Wasm despite input copying; eight persistent Workers were 5.38x faster end to end; exact merge of
eight 16 KiB states was 22.53x faster. Forced Workers at 4K values were 3.45x slower, so dispatch is
not a point-operation optimization.

The reusable design decisions from that admission are:

- route small synchronous batches through JavaScript, bulk batches through Wasm, and only larger
  repeated replacements through persistent Workers; the current measured defaults are 16,384 and
  65,536 values respectively; the Worker threshold is runtime-tunable, while changing the exposed
  synchronous threshold requires new benchmark evidence;
- keep synchronous and Worker orchestration in separate `ultra-log-log` and `ultra-log-log-parallel`
  subpaths so a synchronous Vite build emits no Worker asset;
- define correctness at the state level: an UltraLogLog register contains rank plus history bits, so
  exact merge needs masked rank comparison and `v128.bitselect`, not plain `i8x16.max_u`;
- keep owning Wasm state behind `using`, persistent Worker ownership behind `await using`, and test
  allocator balance plus packaged Worker disposal;
- validate the packed artifact in Node Worker threads, Deno Workers, TypeScript, and Vite because
  source tests do not catch rewritten Worker URLs or missing release files; and
- budget each subpath independently. The recorded isolated gzip payload is 4.08 kB JS + 0.57 kB Wasm
  for the synchronous API and 9.43 kB JS + 0.57 kB Wasm for the Worker API.

Exact benchmark samples and algorithm details remain in
[`experiments/ultra-log-log`](./experiments/ultra-log-log/README.md) and the two public READMEs.
Point-mutation concurrency and speculative synchronization primitives remain low priority because
JavaScript and scalar atomics already win those workloads.

The project concentrates on workloads where Wasm SIMD and persistent Web Workers can cooperate over
immutable or phase-owned bulk data. A transactional row store, WAL, MVCC engine, and single-record
OLTP indexes are out of scope: their scalar point operations, durability boundary, and contention
control do not exercise the project's primary advantage. A future database may consume these OLAP
primitives, but transactional storage belongs in a separate repository.

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
- [x] Replace whole-table rewrites with page-versioned row-group updates. Unchanged immutable column
      pages are reused, and engines sharing one backend object pin observed generations until
      refresh or disposal.
- [x] Add experimental `AggregateStateBlock` for Worker-local count/null-count/sum/min/max state,
      derived average, and barrier-delimited SIMD reduction. The current eight-group query remains
      end-to-end faster than optimized JavaScript, but higher-cardinality merge benchmarks are
      required before extracting this as a public API.
- [x] Evaluate `LocalGroupHashTableU32` with radix-partitioned ownership merge against the current
      low-cardinality group-by and threaded DuckDB-Wasm.
  - [x] Implement the experimental shared-memory SwissTable ABI, nullable i32 aggregate state, and
        persistent-Worker radix-owner merge.
  - [x] Record cardinality-sensitive comparisons with JavaScript `Map`; keep the dense fixed-array
        path for small known key domains.
  - [x] Integrate page pruning/filtering and compare the same sparse-u32 group-by with DuckDB-Wasm
        before considering extraction.
- [x] Evaluate `PartitionedHashJoinTableU32` with caller-owned row-ID output and an optional blocked
      Bloom prefilter.
  - [x] Preserve duplicate build rows and deterministic probe-major/build-input output order in a
        fixed-capacity shared-memory ABI.
  - [x] Let persistent Workers probe one immutable table and write completely disjoint output shards
        without atomics in the hot path.
  - [x] Record the Bloom crossover: it helps when about 90% of probes miss, but its hashing and
        lookup overhead loses when most probe keys hit.
- [x] Add the first `ExecutionChunkI32` metadata contract and a pure physical execution cost model
      that chooses direct SIMD or persistent Workers from surviving ZoneMap pages.
  - [x] Record the count+sum crossover: direct wins clearly through 128 surviving 65,536-row pages,
        256 pages are tied, and eight Workers win 2.00x at 512 pages on the recorded Deno runtime.
  - [x] Connect page-versioned `SchemaEngine` snapshots directly to shared execution chunks without
        reconstructing complete columns. Persisted constant/FOR/raw i32 payloads are validated and
        copied once into shared memory; `SchemaEngine` resident pages remain unpopulated.
  - [x] Add operator/runtime-specific calibration instead of applying the Deno raw count+sum cost
        constants universally. Deno i32 count+sum separates constant/raw/FOR row costs, dense u8
        group-by has its own measured 16/32-page crossover, and Chromium has independent dispatch
        plus Worker page-claim costs verified against raw and adaptive constant/FOR/raw scans.
- [x] Measure whether coordinator-side Wasm compilation can reduce persistent-Worker startup time.
  - [x] Audit the current design against the
        [WebAssembly Threads overview](https://github.com/WebAssembly/threads/blob/main-legacy/proposals/threads/Overview.md):
        the coordinator already waits with `Atomics.waitAsync`, Workers block with `Atomics.wait`,
        and state transitions call `Atomics.notify`. The one-millisecond polling path is only a Deno
        compatibility fallback for a notified `waitAsync` promise that does not resolve.
  - [x] Confirm that the OLAP and shared-runtime WAT modules contain no data segments. The
        proposal's separate one-time data-initialization module therefore does not remove work here;
        the shared header and snapshot payload are already initialized once before Workers attach.
  - [x] Compile the OLAP and shared-runtime `WebAssembly.Module` objects once in the coordinator and
        structured-clone them in each Worker init message. On Apple M5 / Deno 2.6.4, fresh-Worker
        ready latency improved 1.20x / 1.01x / 1.04x / 1.12x for 1 / 2 / 4 / 8 Workers. The one-time
        coordinator compilation took 0.96 ms and was already required for its own two instances, so
        the clone path adds no new compilation phase.
- [x] Make lifecycle guarantees symmetric across the public resident range-aggregate and dense-u8
      group-by pipelines: same-shaped immutable replacement, page-boundary cancellation, Worker
      restart, stale-lease reclamation, and post-operation reuse all share one contract. Keep the
      capacity-bounded sparse-u32 group-by immutable because replacement may require rebuilding it
      with a different hash-table capacity.
- [x] Promote the generation-checked `SharedSelectionMask` from the hybrid experiment into the
      shared runtime. It provides exclusive writer ownership, stale-generation rejection, a padded
      SIMD-aligned word ABI, and row-ID-free handoff to downstream Workers.
- [x] Build the first multi-column selection admission experiment on that shared ABI: two i32
      predicates compose into one published mask reused by masked count/sum/min/max. The corrected
      baseline uses the faster of unrolled and looped fused JavaScript: at 11.9% selectivity SIMD is
      1.04x faster for one measure, at parity for two/four, and 1.12x slower for eight. The result
      is not a robust admission win, so it remains outside the OLAP package.
- [x] Do not adopt the reusable-mask selection pipeline or pursue its downstream-Worker variant. The
      corrected comparison has no robust win over fused JavaScript; keep the implementation as a
      reproducible negative experiment and retain only the independently useful shared-mask ABI.
- [x] Compare copy-inclusive `RadixSortBlockU32/U64` against native typed-array sort. Large random
      blocks win, but small, sorted, and low-cardinality blocks do not; retain a JS fallback.
- [x] Add stable key-plus-row-ID radix output and compare a physical `ORDER BY key` boundary against
      both comparator-based JavaScript and a stronger packed-`BigUint64Array` native sort.
- [x] Add distribution sampling plus already-sorted and native-packed fallbacks. Automatic selection
      prevents catastrophic choices, but its discovery pass remains visible on favorable JS fallback
      inputs.
- [x] Integrate trustworthy sortedness/cardinality metadata from the columnar manifest so the
      operator bypasses discovery. Persist `first`, `last`, and adjacent-inversion facts per
      immutable row group, combine them with min/max at manifest-read time without loading page
      payloads, and publish the admitted stable-u32 operator as
      `@mizchi/jsimd-olap/radix-order-u32`.

### P2: hybrid and vector search

The binary-rerank work remains under
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

- [x] Evaluate concurrent Bloom filters as Worker-local filters plus SIMD OR. A persistent
      four-Worker build plus reduction rebuilt 1M keys 2.46x faster than serial Bloom, but refresh
      plus exact lookup was only 1.08x faster at 90% misses and 1.25-1.28x slower at higher hit
      rates, with noisy p95. Keep the implementation as a negative experiment; the existing
      `ShardedBitmap` already provides the useful phase-owned reduction ABI without adding a narrow
      concurrent Bloom collection.
- [ ] Evaluate `ShardedHashMap` with one mutex per shard and the existing fingerprint table.
- [x] Evaluate `StripedRoaringBitmap` as batched resident posting-list intersection. Four Workers
      lose for one and 16 dense pairs; 64 pairs improve median throughput 1.92x and p95 1.83x. Keep
      the physical batch under `experiments/` as scheduler evidence rather than exporting a
      point-concurrent collection.
- [ ] Evaluate `ConcurrentSplitBlockBloomFilter`, `MultiQueuePriorityQueue`, and
      `ConcurrentAppendLog` only on representative workloads.
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
- [x] `UltraLogLog`: compare exact merge and FGRA estimation against an optimized JavaScript sketch,
      including hashing, input copies, persistent Worker dispatch, output, and disposal.
  - [x] Select JavaScript below 16,384 values and Wasm above it for synchronous ingestion; select
        the serial implementation below 65,536 values and persistent Workers above it for repeated
        replacement. Expose both decisions for diagnostics and allow the runtime-dependent Worker
        threshold to be overridden.
  - [x] Expose synchronous and persistent-Worker planners as separate tree-shakeable jsimd subpaths;
        verify that importing the synchronous path emits no Worker asset.
  - [x] Require exact SIMD merge state to equal serial union ingestion; do not substitute byte max
        for the rank-and-history register transition.
  - [x] Include the Hash4j Apache-2.0 attribution in the tarball and smoke-test the packed Worker
        URL in Node and Deno in addition to TypeScript/Vite builds.
  - [ ] Add pre-hashed 64-bit and byte/string ingestion, statistical accuracy tests, precision
        conversion, and browser measurements.
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
| Worker-local Bloom  | Rebuild won 2.46x; refresh + exact lost except at 90% misses        |

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
