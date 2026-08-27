# Implementation TODO

This file is the actionable queue for `@mizchi/jsimd`. Completed APIs, algorithms, sources,
benchmarks, trade-offs, and standalone build sizes belong in each feature README under
`src/<name>/`. Rejected prototypes keep their evidence under `experiments/<name>/`; implementation
history does not belong in this queue.

## Next: choose a measured workload

There is no unconditionally admitted structure left in the queue. Before adding another public
subpath, define an end-to-end workload and its best JavaScript baseline for one deferred candidate.
The next implementation should be whichever candidate wins that experiment, not whichever name makes
the API look symmetric.

## Queue

### P1: adaptive page composition

- [ ] Keep Delta deferred behind `EliasFanoSequence`, and BitSliced behind `BitSlicedColumn`, until
      a page-composition workload demonstrates a separate win.

### P2: vector pruning

- [ ] Revisit `BlockedVectorArray` block selection and dimension pruning only after a representative
      pruning workload is defined; exhaustive scans alone do not justify those APIs.

### P3: release readiness

- [ ] Before the next publish, review the public API diff and select the release version.
- [ ] Run `just check`, `just memory-profile`, and `pnpm pack --dry-run`; rejected prototypes must
      remain absent from the tarball.
- [ ] Split the root `mod_test.ts` by entrypoint into colocated `src/<name>/*_test.ts` files. Keep
      tests excluded from publish and isolated Vite fixture TypeScript builds.

## v0.2.0: shared-memory and multithreading

WebAssembly SIMD has no atomic `v128` load, store, or read-modify-write operation. Atomic mutation
therefore stays scalar, bulk work stays SIMD, and the two must meet through locks, shard ownership,
striped reduction, or immutable snapshots. Current Wasm atomic operations are sequentially
consistent; do not expose weaker memory-ordering options that the target cannot implement.

The public vocabulary should distinguish four contracts rather than using `Concurrent<T>` for
everything:

- `Atomic<T>`: linearizable scalar point updates
- `Sharded<T>`: one writer owns each shard
- `Striped<T>`: worker-local mutation followed by bulk reduction
- `Snapshot<T>`: immutable versions published atomically

Sources:
[WebAssembly Threads overview](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md#atomic-memory-accesses),
[`Atomics.wait`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait),
and
[`Atomics.waitAsync`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync).

### Phase 0: shared-memory ABI and test harness

- [x] Define `SharedBuffer`, alignment, cache-line padding, headers, versioning, worker IDs, and
      attach/detach ownership. Shared structures must be views over an explicitly shared backing
      memory, not hidden module-local memories.
- [x] Define how independently instantiated worker modules import the same shared
      `WebAssembly.Memory`, including fixed maximum pages and feature detection.
- [x] Specify `using` semantics for shared leases, snapshots, and handles separately from ownership
      of the backing memory.
- [x] Build deterministic Node Worker, Deno Worker, and cross-origin-isolated Vite/browser worker
      smoke tests with contended scalar atomic updates and lease-return checks.
- [ ] Add forced Worker termination recovery, generation/stale-lease detection, and shared allocator
      plateau cases after the allocator header owns reclamation metadata.
- [ ] Benchmark 1/2/4/8 workers against `postMessage`, JavaScript `SharedArrayBuffer` + `Atomics`,
      and single-threaded SIMD. Report throughput, tail latency, contention, and false-sharing
      effects.

### Phase 1: synchronization and allocation

- [x] Implement worker-blocking `Mutex`, `Barrier`, and `WaitGroup` first; expose asynchronous
      main-thread waits through `Atomics.waitAsync` rather than blocking `Atomics.wait`.
- [ ] Add `RwLock`, `Condvar`, `Semaphore`, and `OnceCell` only when a consumer requires them.
- [x] Implement `SharedBlockPool` with fixed 256-byte, 1 KiB, and 4 KiB size classes, a global
      atomic bump pointer, per-worker caches, and mutex-protected free lists. Defer lock-free free
      lists until ABA-safe reclamation exists.

### Phase 2: transport and handles

- [x] Implement fixed-payload `SpscRingBufferU32` with cache-line-separated head/tail fields,
      exclusive disposable roles, blocking/async backpressure, native-array bulk operations, and
      SIMD shared-to-shared `pushManyFromShared` / `popManyToShared` copies.
- [x] Implement sequence-numbered `MpmcRingBufferU32` with cache-line-separated enqueue/dequeue
      positions, per-slot publish/recycle sequences, blocking/async backpressure, u32 rollover
      tests, and fixed-width integer handles rather than JavaScript objects.
- [x] Implement `SharedSlotMap` with generation-tagged 64-bit handles, atomic slot state,
      SIMD-aligned fixed-size payloads, disposable owning leases, concurrent allocation, and
      stale-handle/ABA detection.
- [x] Add an SPSC/MPMC `u64` transport variant before using generation-tagged `SharedSlotMap`
      handles as queue payloads. Do not split a handle across independently published u32 entries.

### Phase 3: bitmap and reduction primitives

- [x] Implement `AtomicDenseBitmap` scalar RMW operations: `set`, `clear`, `toggle`, `testAndSet`,
      and `testAndClear`. Concurrent bulk reads must not claim snapshot consistency.
- [x] Implement `ShardedBitmap` with worker-owned mutable dense bitmap shards and barrier-delimited
      SIMD OR/AND snapshot reduction.
- [x] Implement `StripedCounter` and `StripedHistogram`; reuse the reduction pattern later for Bloom
      filters, min/max, and approximate sketches. `ShardedBitmap` already provides the same
      worker-local full-bitmap stripes and SIMD OR/AND reduction that a separate
      `StripedDenseBitmap` name would duplicate.
- [ ] Evaluate concurrent Bloom filters as worker-local filters plus SIMD OR first. Atomic OR with
      concurrent queries must either document temporary false negatives or add versioned blocks.

### Phase 4: immutable publication and scheduling

- [x] Implement `VersionedBuffer` with double buffering, atomic publication, reader guards, and safe
      buffer reuse. Readers must only run SIMD over immutable published regions.
- [x] Implement a fixed-capacity `WorkStealingDequeU32` of integer task handles, with owner bottom
      operations and CAS-based stealing.
- [ ] Implement `EpochDomain` only when snapshot reuse or segmented lock-free structures cannot be
      handled by locks or barriers.

### Phase 5: derived concurrent collections

- [ ] Evaluate `ShardedHashMap` using a mutex per shard and the existing SIMD fingerprint table.
- [ ] Evaluate `StripedRoaringBitmap`, `ConcurrentSplitBlockBloomFilter`, `ShardedOrderedMap`,
      `MultiQueuePriorityQueue`, and `ConcurrentAppendLog` only on representative workloads.
- [ ] Do not start with a fully lock-free hash map. Admit an upper-level collection only when it
      beats the best sharded JavaScript or shared-memory baseline end to end.

Do not add symmetric names such as `SimdFloat32Array`, `SimdInt32Vector`, or a standalone
`BitVector` without a measured workload that wins after boundary costs.

## Public naming

Canonical bitmap entrypoints:

- `bitmap`: mutable `Bitmap` and fixed-universe `DenseBitmap`
- `rank-select-bit-vector`: frozen indexed `RankSelectBitVector`
- `roaring-bitmap`: mutable adaptive-container `RoaringBitmap`

`BitVector` and `bit-vector` are reserved for a possible immutable packed boolean sequence without
rank/select metadata. They are not currently exported.

Removed pre-announcement aliases:

- `bitset`
- `bit-vector`
- `rank-select-bitvector`
- `rank-select-bitmap`
- `roaring-uint32-set`

Do not add compatibility aliases before a real compatibility obligation exists.

## Admission policy

- A public operation overlapping `Map`, `Set`, typed arrays, strings, or another JavaScript builtin
  must beat the best equivalent implementation in its primary end-to-end workload.
- Include construction, key conversion, JS/Wasm copies, output materialization, and disposal unless
  the documented usage explicitly amortizes them.
- Storage savings or an isolated Wasm kernel win is insufficient.
- Bulk-oriented structures may keep slower point conveniences, but documentation must identify those
  calls as outside the performance contract.
- If no representative workload wins, remove the package export and keep only the benchmark and
  minimal prototype needed as rejection evidence.
- Breaking removals and renames remain allowed until the first public announcement.

## Rejected prototypes

| prototype           | reason for rejection                                            |
| :------------------ | :-------------------------------------------------------------- |
| `StaticMphfBytes`   | Lookup 2.26x and construction 94.8x slower than pre-encoded Set |
| `SuccinctTrie`      | Exact lookup and prefix ranges lost to JavaScript               |
| `StringInterner`    | Native `Map<string, u32>` owns decoded-string point lookup      |
| `LoudsTree`         | Batched parent navigation 6.70x slower than `Uint32Array`       |
| `PackedUint32Array` | Decode and gather lost to typed arrays                          |
| `PackedDeltaArray`  | FOR+BP128 unpack and queries lost to typed arrays/Stream VByte  |
| sparse-matrix BFS   | Direct JavaScript adjacency traversal was 1.70x faster          |

These are not package exports. Revisit one only with a materially different layout or workload.

## Deferred candidates

- `RangeFilterU32`: only if measured ZoneMap false positives justify it
- `SemiringGraph`: only when it reuses a winning dense or sparse matrix layout
- `SimdPriorityQueue`
- `SimdOrderedIndex`
- `MortonSpatialIndex`
- `UltraLogLog`

## Definition of done

- Develop with exploration -> Red -> Green -> refactoring.
- Separate mutable builders from frozen query representations where their layouts conflict.
- Design and benchmark bulk operations before point conveniences.
- Keep data resident for repeated operations and also measure copy-inclusive one-shot use.
- Use `using` in every public owning-structure example.
- Keep each entrypoint under `src/<name>/` with its own WAT source and typed Wasm declaration.
- Generate and strip with `wasm-tools`, validate SIMD, and keep generated Wasm Git-ignored.
- Verify an isolated Vite fixture emits exactly one expected Wasm asset.
- Record benchmark sources, baselines, minified JS/Wasm raw and gzip sizes, and slower JS cases in
  the feature README.
- Compare with the best relevant builtin, typed-array implementation, or established library.
- Test allocator reuse plateaus, exceptional cleanup, and use-after-dispose.

## Longer-term generated layout

Consider a schema-generated physical layout only after multiple adaptive encodings and at least one
string representation have stable measured contracts. Do not start a schema DSL before then.
