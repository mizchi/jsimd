# Implementation TODO

This is the working implementation queue for the data-structure and columnar-engine direction of
`@mizchi/jsimd`. `ROADMAP.md` is the short public summary; this file records concrete deliverables,
dependencies, benchmarks, and decision gates.

## Current status

- [x] `RankSelectBitVector`
  - immutable build/freeze representation
  - scalar and bulk rank/select queries
  - 512-bit rank index
- [x] `RoaringUint32Set`
  - mutable array and bitmap containers
  - non-materializing intersection queries
  - reusable-output intersection
- [x] `PackedDeltaUint32List`
  - frozen Stream VByte control/data streams
  - 128-value checkpoints and SIMD group intersection
- [x] `SimdFlatHashMap/Set`
  - `FlatHashSetU32` and `FlatHashMapU32U32`
  - bulk probing/insertion and allocator plateau tests
- [x] `BitSlicedColumn`
  - nullable `BitSlicedColumnU8`
  - same-memory composable `BitSliceMask`
- [x] `WaveletMatrixUint32`
  - binary 32-level layout over the complete Uint32 domain
  - access, rank/select, range frequency, quantile, and predecessor
  - batch access/rank/quantile kernels
- [x] `EliasFanoSequence`
  - non-decreasing Uint32 input with duplicate preservation
  - packed lower bits and unary high-bit rank/select
  - random access, rank, nextGEQ, predecessor, batch access/rank, and bulk decode
- [x] `AdaptiveSimdPageI32`
  - up to 256 signed rows with Constant, FrameOfReference, or Raw storage
  - ZoneMap fast paths, resident composable masks, scans, gather, decode, and sum
- [x] `StaticMphfU32`
  - hash-and-displace construction over unique Uint32 keys
  - dense IDs, 16-bit membership fingerprints, and four-query first-hash SIMD batching
  - explicit freeze-once/batch-query benchmark gate against FlatHash and `Set<number>`
- [x] Reject the initial `SuccinctTrie` prototype: exact lookup was about 69x slower than `Set`, and
      prefix range was about 1.67x slower than two lower bounds over a sorted string array. Revisit
      only if it becomes required topology for another structure or a new layout wins.
- [x] `BinaryVectorIndex` — **0.1.0 candidate**

## Public API symmetry audit

The names describe contracts and workload families, not a requirement to mirror every scalar type
with every operation.

| API                 | Status                      | Decision                                                                                                                                                                 |
| :------------------ | :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FixedBitSet`       | fixed-universe dense set    | Keep the prefix: bounds and equal-capacity algebra are part of its contract.                                                                                             |
| `BitSet`            | growable dense set          | Implemented beside `FixedBitSet`; growth is outside SIMD bulk kernels.                                                                                                   |
| `SimdInt32Array`    | fixed-length typed storage  | Keep `Array`: point access, reductions, equality, and element-wise mutation are its primary API. Typed arrays are already fixed-length, so a `Fixed` prefix adds little. |
| `SimdFloat32Vector` | dot and AXPY vertical slice | The missing array operations have not been ruled out by benchmarks; this is incomplete coverage, not a performance conclusion.                                           |
| `SimdInt32Vector`   | not implemented             | Do not add for superficial symmetry. Define i32 dot overflow/return semantics and a real integer-vector workload first.                                                  |

Before the first release, benchmark Float32 `get/set/fill`, reductions, equality, and in-place add
against `Float32Array`. If the resident bulk operations win, expand and rename the entrypoint/type
to `f32-array` / `SimdFloat32Array`, retaining `dot` and `addScaled` as bulk methods. Since the
package is still `0.0.0`, avoid carrying both names unless a real vector-specific contract emerges.

## Committed implementation order

### 1. PackedDeltaUint32List — Stream VByte implementation complete

Build an immutable representation for sorted monotone `Uint32` values. It complements resident
`SimdInt32Array` and mutable `RoaringUint32Set` with a compressed postings/offset representation.

Public contract:

```ts
interface PackedDeltaUint32List {
  readonly length: number;
  at(index: number): number;
  lowerBound(value: number): number;
  nextGEQ(value: number): number;
  decodeInto(start: number, output: Uint32Array): number;
  intersectInto(other: PackedDeltaUint32List, output: Uint32Array): number;
}
```

Tasks:

- [x] Define `PackedDeltaUint32ListBuilder.freeze()` and immutable ownership semantics.
- [x] Reject unsorted or duplicate input explicitly; do not silently normalize it.
- [x] Prototype Stream VByte using a separate control/data stream and `i8x16.swizzle` decoding.
- [ ] Prototype FOR+BP128 with a block base, bit width, and packed payload.
- [x] Add a random-access checkpoint every 128 or 256 integers.
- [x] Add scalar and bulk queries; optimize `decodeInto` and `intersectInto` before point access.
- [ ] Benchmark postings, source offsets, timestamps, adjacency lists, and dense local runs.
- [ ] Compare compressed bytes/value, construction cost, point lookup, bulk decode, and
      intersection.
- [ ] Compare against sorted `Uint32Array`, `RoaringUint32Set`, and `EliasFanoSequence`.

Decision gate:

- Keep Stream VByte and FOR+BP128 only when they win distinct workload classes.
- If Elias–Fano dominates monotone random-access workloads, keep PackedDelta focused on sequential
  decode and intersection instead of duplicating Elias–Fano queries.

Reference: [Techniques for Inverted Index Compression](https://arxiv.org/html/1908.10598v2)

### 2. SimdFlatHashMap/Set — initial implementation complete

Build typed-key hash tables, not replacements for JavaScript's arbitrary-key `Map` and `Set`.

Initial deliverables:

- [x] `FlatHashSetU32`
- [x] `FlatHashMapU32U32`
- [x] 16-byte SwissTable-style control groups and 7-bit fingerprints
- [x] `lookupMany`, `insertMany`, and reusable-output probing
- [x] growth/rehash behavior with allocator plateau tests
- [x] comparisons against `Set<number>`, `Map<number, number>`, and sorted arrays

Later derivatives:

- [ ] `FlatHashMapU64U32`
- [ ] `FlatHashMapFixed16U32` for UUID/hash keys
- [ ] `StringInterner` backed by a byte arena and `u32` handles
- [ ] Evaluate `TinyPointerHashTable` as an alternative metadata layout

Unknown JavaScript objects and arbitrary values remain out of scope. A static key set should use the
future `StaticMPHF` rather than paying for mutable table metadata.

Reference: [Abseil Swiss Tables design](https://abseil.io/about/design/swisstables)

### 3. BitSlicedColumn — initial implementation complete

Build mostly-static integer columns that produce composable selection bitsets.

- [x] Start with `BitSlicedColumnU8` and an explicit bit width.
- [x] Add `eq`, `lt`, and `between` with reusable same-memory `BitSliceMask` output.
- [x] Add null-mask handling without assigning a sentinel value.
- [x] Compose predicates without materializing matching row IDs.
- [x] Compare with `Uint8Array` scalar scans and native typed-array loops.
- [ ] Reuse the layout as one encoding inside `AdaptiveSimdPage`.

The structure is for scans, not fast individual value extraction. Keep an ordinary value array when
the workload needs both point access and repeated predicates.

### 4. WaveletMatrixUint32 — initial implementation complete

Build the first higher-level succinct structure after rank/select and bit-sliced predicates settle.

Public contract:

- [x] `access(index)`
- [x] `rank(value, end)` and `select(value, rank)`
- [x] `rangeFreq(left, right, min, max)`
- [x] `quantile(left, right, kth)`
- [x] `predecessor(left, right, value)`
- [x] batch access, rank, and quantile variants for independent queries

The implementation embeds the same 512-bit rank-index design as `RankSelectBitVector` in one
self-contained Wasm module. Keeping all 32 levels inside a single call avoids paying the JS/Wasm
boundary once per level. Evaluate a 4-ary representation only after the binary benchmark baseline.

Reference: [Faster Wavelet Tree Queries](https://arxiv.org/html/2302.09239v2)

## Research-derived build tracks

These tracks do not change the committed order above. They define what to build after, or alongside,
the first six structures when a dependency or comparison requires it.

### Succinct and frozen indexes

| Candidate               | Concrete deliverable                                          | Dependency / decision                                                  |
| :---------------------- | :------------------------------------------------------------ | :--------------------------------------------------------------------- |
| `EliasFanoSequence`     | `at`, `rank`, `nextGEQ`, `predecessor` over monotone `Uint32` | Build as the main PackedDelta comparison; reuse `RankSelectBitVector`  |
| Partitioned Elias–Fano  | Per-block choice among EF, dense bitmap, and contiguous range | Add only after plain EF and PackedDelta benchmarks                     |
| `StaticMphfU32`         | Frozen Uint32 → `[0,n)` mapping plus 16-bit fingerprint       | Initial implementation complete; batch wins, single calls do not       |
| Byte-key `StaticMPHF`   | Hash UTF-8 slices in a frozen byte arena before MPHF routing  | Build with CompressedStringTable; do not copy each query independently |
| `SuccinctTrie`          | LOUDS prototype rejected after JS comparison                  | No dependency needs it; redesign only with a new measured workload     |
| `CompressedStringTable` | ID-based get/equals/hash with FSST, OnPair16, or front coding | Pair with StaticMPHF for frozen symbol tables                          |

References:

- [PtrHash](https://arxiv.org/html/2502.15539v1)
- [C² cache-conscious succinct tries](https://arxiv.org/html/2606.16104v1)
- [OptFSST](https://arxiv.org/html/2607.11271v1)
- [OnPair](https://arxiv.org/html/2508.02280v1)

### Adaptive columnar execution

The long-term goal is a small columnar execution engine, not a collection of unrelated compressed
classes.

1. [ ] `ZoneMapU32` with page-level min/max pruning.
2. [ ] `RangeFilterU32` only if ZoneMap false positives justify extra storage.
3. [x] `AdaptiveSimdPageI32` with up to 256 rows per page.
4. [x] Selection-mask operations: `scanEq`, `scanLt`, `scanBetween`.
5. [x] `decodeInto`, `gatherInto`, and `sum`.
6. [x] Initial frozen selection among Constant, FrameOfReference, and Raw.
7. [ ] Extend frozen repacking with Delta, RLE, Dictionary, Sparse, and BitSliced only when each
       encoding wins an end-to-end page workload.

Candidate page encodings:

| Encoding                     | Selection signal            | Existing/future dependency       |
| :--------------------------- | :-------------------------- | :------------------------------- |
| Constant                     | all values equal            | none                             |
| Raw                          | default or recently updated | `SimdInt32Array` kernels         |
| FrameOfReference / BitPacked | narrow local value range    | PackedDelta bit-pack primitives  |
| Delta                        | monotone or locally smooth  | PackedDelta                      |
| RunLength                    | few value transitions       | new RLE kernel                   |
| Dictionary                   | few distinct values         | FlatHash/StaticMPHF during build |
| Sparse                       | few non-default rows        | Elias–Fano or bitmap             |
| BitSliced                    | repeated range predicates   | `BitSlicedColumn`                |

Do not decode every page before every operator. The target interface keeps intermediate selection
masks and compressed pages resident across `scan`, `aggregate`, and `gather`.

References:

- [bloomRF](https://arxiv.org/html/2207.04789v2)
- [MorphStore](https://arxiv.org/html/2004.09350v1)
- [ZipFlow](https://arxiv.org/html/2602.08190v1)

### Typed packed arrays and common contracts

- [ ] `PackedUint32Array`: fixed-width random access for arbitrary unsigned values; benchmark each
      width against `Uint32Array` before exposing it as a general replacement.
- [ ] `MonotoneUint32Sequence`: a shared read-only contract or factory over Elias–Fano, PackedDelta,
      dense bitmap, and contiguous ranges. Avoid adding a wrapper if dispatch overhead erases the
      benefit of the selected encoding.
- [ ] `PackedDeltaArray`: clarify whether this means signed/general delta coding or a block-adaptive
      successor to `PackedDeltaUint32List`, then add random access, bulk decode, and intersection
      workloads without duplicating the existing monotone type.
- [ ] `BitMatrix`: resident dense rows, transpose, boolean multiplication, and selection-mask row
      views; switch large sparse rows to Roaring or CSR.

### Search, spatial, graph, and statistics

| Candidate            | First build                                                                | Gate before expansion                                      |
| :------------------- | :------------------------------------------------------------------------- | :--------------------------------------------------------- |
| `BinaryVectorIndex`  | 1-bit signatures, Hamming `distanceMany`, top-k candidates, Float32 rerank | Compare recall, build size, and end-to-end search latency  |
| `PDXVectorBlock`     | dimension-major blocks for one-query/four-candidate exact scoring          | Keep only if it beats existing f32 vector loops            |
| `MortonSpatialIndex` | 2D Morton encode, sorted codes, range lookup                               | Target immutable tiles; use Elias–Fano/PackedDelta storage |
| `BitMatrix`          | resident dense rows, transpose, boolean multiply                           | Switch large sparse rows to Roaring/CSR                    |
| `SemiringGraph`      | reachability/BFS kernels over BitMatrix or sparse rows                     | Add only after the matrix storage choice is benchmarked    |
| `UltraLogLog`        | add, merge with `i8x16.max_u`, estimate                                    | Compare error and bytes against HLL implementations        |
| `BitHistogram32`     | positional popcount over batches of masks                                  | Require a real flags/feature histogram workload            |

References:

- [QuIVer](https://arxiv.org/html/2605.02171v3)
- [PDX vector layout](https://arxiv.org/html/2503.04422)
- [MapLibre Tile / Morton ordering](https://arxiv.org/html/2508.10791v1)
- [SlimSell](https://arxiv.org/abs/2010.09913)
- [UltraLogLog](https://ar5iv.labs.arxiv.org/html/2308.16862)
- [Faster Positional-Population Counts](https://arxiv.org/html/2412.16370v1)

## Design rules for every implementation

- [ ] Separate mutable builders from frozen representations when update and query layouts conflict.
- [ ] Separate approximate filters from exact indexes; filters only prune pages or candidates.
- [ ] Design bulk operations first: `lookupMany`, `rankMany`, `distanceMany`, `scanPage`, and
      `intersectInto`.
- [ ] Keep data resident across repeated operations and include copy-inclusive one-shot benchmarks.
- [ ] Use `using` in every public example so `Symbol.dispose` reliably returns Wasm storage.
- [ ] Put each entrypoint under `src/<name>/` with its own WAT source and typed Wasm declaration.
- [ ] Generate, strip, and validate Wasm; keep generated binaries Git-ignored.
- [ ] Verify a Vite production fixture emits exactly the imported entrypoint's Wasm.
- [ ] Commit Vitest baseline JSON and summarize results in the entrypoint README.
- [ ] Compare against the best relevant JavaScript builtin or typed-array implementation.
- [ ] Do not publish a structure whose useful workload does not beat its JavaScript alternative.
- [ ] Document the data layout and algorithm with primary sources or reference implementations.
- [ ] Record the isolated Vite JS/Wasm raw and gzip sizes in the entrypoint README.
- [ ] State whether the structure consistently beats JavaScript or only wins a bounded workload;
      document construction, memory, point-access, and boundary-cost trade-offs.
- [ ] Develop with exploration → Red → Green → refactoring and test allocator plateau behavior.

## Longer-term generated layout

If the page encodings stabilize, explore generating physical layouts and kernels from a schema:

```ts
schema({
  kind: u8().dictionary().bitSlice(),
  start: u32().monotone().eliasFano(),
  name: string().intern().fsst(),
  flags: u16().bitSlice(),
});
```

This is a long-term unification target. Do not start a schema DSL before at least
`PackedDeltaUint32List`, `BitSlicedColumn`, one string representation, and `AdaptiveSimdPage` have
stable measured contracts.
