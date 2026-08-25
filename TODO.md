# Implementation TODO

This is the single roadmap and working queue for `@mizchi/jsimd`. Completed work is summarized
briefly; detailed APIs, design sources, benchmarks, trade-offs, and standalone build sizes live in
each `src/<name>/README.md`.

## Current status

| component                              | status   | current scope                                                    |
| :------------------------------------- | :------- | :--------------------------------------------------------------- |
| `RankSelectBitVector`                  | complete | Frozen rank/select/neighbor queries and bulk APIs                |
| `RoaringUint32Set`                     | complete | Mutable array/bitmap containers and reusable intersections       |
| `PackedDeltaUint32List`                | complete | Frozen Stream VByte lists, checkpoints, decode, and intersection |
| `FlatHashSetU32` / `FlatHashMapU32U32` | complete | Mutable typed tables with bulk probing and insertion             |
| `BitSlicedColumnU8`                    | complete | Nullable predicates and resident composable masks                |
| `WaveletMatrixUint32`                  | complete | Access, rank/select, range frequency, quantile, and predecessor  |
| `EliasFanoSequence`                    | complete | Compressed monotone access, rank, neighbors, and bulk decode     |
| `AdaptiveSimdPageI32`                  | complete | Constant, FOR, or Raw pages with scans, masks, gather, and sum   |
| `StaticMphfU32`                        | complete | Frozen dense IDs, fingerprints, and batched lookup               |
| `BinaryVectorIndex`                    | complete | Resident binary signatures and exhaustive Hamming scans          |
| `SuccinctTrie`                         | rejected | Prototype lost exact lookup and prefix queries to JavaScript     |

New entrypoints must justify both their Wasm boundary and their independently tree-shaken bundle
cost.

## Next implementation queue

### 1. Packed integer layouts

- [ ] `PackedUint32Array`: fixed-width random access for arbitrary unsigned values.
- [ ] Prototype FOR+BP128 as an alternative block codec for `PackedDeltaUint32List`.
- [ ] `PackedDeltaArray`: first decide whether this means signed/general delta coding or a
      block-adaptive successor to `PackedDeltaUint32List`.
- [ ] Benchmark point access, lower bound, full decode, and intersection over postings, source
      offsets, timestamps, adjacency lists, and dense local runs.
- [ ] Compare bytes/value and end-to-end latency with `Uint32Array`, `PackedDeltaUint32List`,
      `EliasFanoSequence`, and `RoaringUint32Set`.

Keep a codec only when it wins a distinct workload after construction and materialization costs are
included. Elias–Fano should remain the random-query representation if packed delta only wins
sequential decode or intersection.

Reference: [Techniques for Inverted Index Compression](https://arxiv.org/html/1908.10598v2)

### 2. Shared monotone contract

- [ ] Evaluate a `MonotoneUint32Sequence` read-only contract or factory over Elias–Fano,
      PackedDelta, dense bitmap, and contiguous-range representations.
- [ ] Measure interface dispatch before adding a wrapper; do not publish an abstraction that erases
      the selected encoding's benefit.
- [ ] Consider partitioned Elias–Fano only after block-level density measurements show that global
      Elias–Fano leaves meaningful space or query performance on the table.

### 3. Adaptive columnar pages

- [ ] Add a multi-page column with page-level ZoneMap pruning; the existing page already stores
      `min` and `max`.
- [ ] Add `RangeFilterU32` only if measured ZoneMap false positives justify its storage.
- [ ] Evaluate Delta, RLE, Dictionary, Sparse, and BitSliced page encodings independently.
- [ ] Keep selection masks resident across multi-page `scan`, `aggregate`, and `gather` operations.
- [ ] Reuse `BitSlicedColumn` inside an adaptive page only if it avoids another Wasm module or a
      full mask copy.

Each new encoding must beat Constant/FOR/Raw on an end-to-end page workload, not merely compress a
synthetic payload.

References: [MorphStore](https://arxiv.org/html/2004.09350v1),
[ZipFlow](https://arxiv.org/html/2602.08190v1), [bloomRF](https://arxiv.org/html/2207.04789v2)

### 4. BitMatrix and graph kernels

- [ ] `BitMatrix`: resident dense rows, transpose, boolean multiplication, and row views.
- [ ] Compare dense rows with Roaring or CSR storage before supporting large sparse matrices.
- [ ] Add reachability or BFS kernels only after the storage choice wins a real dependency-graph
      workload.
- [ ] Keep `SemiringGraph` deferred until it can reuse a measured `BitMatrix` or sparse-row layout.

Reference: [SlimSell](https://arxiv.org/abs/2010.09913)

### 5. Typed hash and string derivatives

- [ ] `FlatHashMapU64U32` only with a real 64-bit-key workload.
- [ ] `FlatHashMapFixed16U32` for UUID or fixed-hash keys.
- [ ] Byte-key `StaticMPHF` plus a frozen byte arena.
- [ ] `CompressedStringTable` using front coding, FSST, or OnPair16; compare against an ordinary
      byte arena before adding compression.
- [ ] `StringInterner` with `u32` handles only if bulk lookup amortizes UTF-8 copying.

Do not add arbitrary JavaScript object keys or values. Native `Map` and `Set` already own that
workload.

References: [Abseil Swiss Tables](https://abseil.io/about/design/swisstables),
[PtrHash](https://arxiv.org/html/2502.15539v1), [OptFSST](https://arxiv.org/html/2607.11271v1),
[OnPair](https://arxiv.org/html/2508.02280v1)

### 6. Numeric and vector follow-ups

- [ ] Benchmark Float32 `get`, `set`, `fill`, reductions, equality, and in-place add against
      `Float32Array` before considering `SimdFloat32Array`.
- [ ] Keep `SimdFloat32Vector` focused on dot and AXPY until those array workloads win.
- [ ] Do not add `SimdInt32Vector` for naming symmetry; define overflow semantics and a real integer
      vector workload first.
- [ ] Evaluate PDX dimension-major blocks only if they beat existing resident Float32 loops for
      exact multi-candidate scoring.
- [ ] Add Float32 reranking to `BinaryVectorIndex` only with an end-to-end recall/latency benchmark.

References: [PDX vector layout](https://arxiv.org/html/2503.04422),
[QuIVer](https://arxiv.org/html/2605.02171v3)

## Deferred candidates

These remain below the queue until a concrete workload suggests an advantage over JavaScript or an
established library:

- `BlockedBloomFilter` or another negative-lookup filter
- `SimdPriorityQueue`
- `SimdOrderedIndex`
- `MortonSpatialIndex`
- `UltraLogLog`
- `BitHistogram32`

`SuccinctTrie` remains rejected: the removed prototype was about 69x slower than `Set` for exact
lookup and about 1.67x slower than two lower bounds over a sorted string array for prefix ranges.
Revisit it only when another structure requires succinct topology or a substantially different
layout has a credible benchmark.

## Invariants for every implementation

- Separate mutable builders from frozen representations when update and query layouts conflict.
- Design bulk operations first: `lookupMany`, `rankMany`, `distanceMany`, `scanPage`, and
  `intersectInto`.
- Keep data resident across repeated operations and also measure copy-inclusive one-shot use.
- Use `using` in every public example so `Symbol.dispose` reliably returns Wasm storage.
- Put each entrypoint under `src/<name>/` with its own WAT source and typed Wasm declaration.
- Generate with `wasm-tools`, strip custom sections, validate SIMD, and keep binaries Git-ignored.
- Verify an isolated Vite fixture emits exactly the imported entrypoint's Wasm.
- Record benchmark sources and baselines, minified JS/Wasm raw and gzip sizes, and explicit
  slower-than-JavaScript cases in the entrypoint README.
- Compare against the best relevant JavaScript builtin, typed-array implementation, or established
  library.
- Test allocator reuse plateaus and exceptional cleanup for every owning type.
- Develop with exploration → Red → Green → refactoring.

## Longer-term generated layout

If the page encodings stabilize, consider generating physical layouts and kernels from a schema:

```ts
schema({
  kind: u8().dictionary().bitSlice(),
  start: u32().monotone().eliasFano(),
  name: string().intern().fsst(),
  flags: u16().bitSlice(),
});
```

Do not start a schema DSL before at least one string representation and multiple adaptive page
encodings have stable measured contracts.
