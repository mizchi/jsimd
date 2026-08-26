# Implementation TODO

This is the single roadmap and working queue for `@mizchi/jsimd`. Completed work is summarized
briefly; detailed APIs, design sources, benchmarks, trade-offs, and standalone build sizes live in
each `src/<name>/README.md`.

## Current status

| component                              | status   | current scope                                                    |
| :------------------------------------- | :------- | :--------------------------------------------------------------- |
| `BitVector` / `RankSelectBitmap`       | complete | Frozen rank/select/neighbor queries and bulk APIs                |
| `Bitmap` / `DenseBitmap`               | complete | Growable/fixed dense bitmaps; compatibility aliases retained     |
| `RoaringBitmap`                        | complete | Mutable array/bitmap containers and reusable intersections       |
| `PackedDeltaUint32List`                | complete | Frozen Stream VByte lists, checkpoints, decode, and intersection |
| `FlatHashSetU32` / `FlatHashMapU32U32` | complete | Mutable typed tables with bulk probing and insertion             |
| `FlatHashMapFixed16U32` / set          | complete | Fused fingerprint and v128 full-key probes                       |
| `ByteKeyFlatHashMapU32`                | complete | Bulk 2.00x faster; point lookup 12.5x slower than native Map     |
| `FingerprintGroup16/Table16`           | complete | SwissTable masks; multi-group batch probes are 4.91x faster      |
| `BitSlicedColumnU8`                    | complete | Nullable predicates and resident composable masks                |
| `BitMatrix`                            | complete | Dense rows, non-owning views, transpose, and Boolean product     |
| `WaveletMatrixUint32`                  | complete | Access, rank/select, range frequency, quantile, and predecessor  |
| `EliasFanoSequence`                    | complete | Compressed monotone access, rank, neighbors, and bulk decode     |
| `AdaptiveSimdPageI32`                  | complete | Constant, FOR, or Raw pages with scans, masks, gather, and sum   |
| `AdaptiveSimdColumnI32`                | complete | Multi-page ZoneMaps, resident masks, scans, gather, and sum      |
| `SparseBitMatrix`                      | complete | Frozen CSR rows; BFS rejected after losing to JS adjacency       |
| `PartitionedEliasFanoSequence`         | complete | Contiguous or local-EF blocks for clustered monotone values      |
| `StaticMphfU32`                        | complete | Frozen dense IDs, fingerprints, and batched lookup               |
| `StaticMphfBytes` / frozen map         | complete | Exact arbitrary-byte membership and optional `u32` values        |
| `CompressedStringTable`                | complete | Block-local front coding and SIMD equality without decode        |
| `WaveletMatrixUint8`                   | complete | Eight-level byte rank/select and range statistics                |
| `FmIndexBytes`                         | complete | Batched count plus bitvector-sampled locate                      |
| `BinaryVectorIndex`                    | complete | Resident binary signatures and exhaustive Hamming scans          |
| `PdxFloat32Index` / rerank             | complete | Four-candidate exact L2 and binary-to-Float32 refinement         |
| `FlatHashMapU64U32`                    | complete | BigInt point keys and batched `BigUint64Array` lookup            |
| `SuccinctTrie`                         | rejected | Prototype lost exact lookup and prefix queries to JavaScript     |
| `StringInterner`                       | rejected | Native `Map<string,u32>` owns decoded-string interning           |
| `LoudsTree` topology                   | rejected | Batched parent navigation was 6.70x slower than `Uint32Array`    |
| `PackedUint32Array`                    | rejected | Compact payload, but decode and gather lost to typed arrays      |
| `PackedDeltaArray` (FOR+BP128)         | rejected | Smaller blocks did not offset unpack and query costs             |

New entrypoints must justify both their Wasm boundary and their independently tree-shaken bundle
cost.

## User-facing completion queue

The library already covers enough distinct structure families. Complete the contracts and connect
the existing structures before adding another standalone type.

### P0: Complete existing public contracts

#### 1. Complete `RoaringBitmap` set algebra

- [ ] Add materializing and reusable-output `or`, `xor`, and `andNot` operations alongside the
      existing `and` / `andInto` path.
- [ ] Add `orCardinality`, `xorCardinality`, and `andNotCardinality` so callers can avoid
      materializing intermediate sets.
- [ ] Add batched membership into a caller-owned `Uint8Array`.
- [ ] Benchmark every retained array/bitmap container pairing against the best typed-array or native
      `Set` reference and record construction separately.

This is the most visible API gap: users choosing a Roaring bitmap reasonably expect union,
difference, and symmetric difference without converting to another representation.

#### 2. Complete the zero-bit side of `BitVector`

- [ ] Add `rank0Many`, `select0`, `select0Many`, `next0`, and `prev0`.
- [ ] Define tail semantics so padding beyond `capacity` is never observable as a zero bit.
- [ ] Match the existing scalar/randomized rank/select coverage and add bulk benchmarks.

`rank0` already exists, so leaving selection and neighbor queries one-sided makes the `BitVector` /
`RankSelectBitmap` contract appear incomplete.

#### 3. Standardize allocation-free output APIs

- [ ] Add caller-owned output paths for bitmap set positions, hash keys/entries, sparse-matrix rows,
      and Roaring ranges where only allocating or callback forms currently exist.
- [ ] Use consistent `*Into(output) -> writtenCount` semantics and reject undersized or wrong typed
      outputs before entering Wasm.
- [ ] Keep allocating convenience methods as thin wrappers over the `Into` contract.

Priority targets are `Bitmap`, `FlatHashMap*`, `SparseBitMatrix`, and `RoaringBitmap`. Avoid a
generic iterator abstraction in hot paths; typed bulk output is the common interoperability layer.

### P1: Persistence and composition

#### 4. Add versioned snapshots for expensive frozen structures

- [ ] Define a small binary envelope with magic, format version, structure kind, logical shape, and
      payload lengths. Invalid or truncated snapshots must fail before allocation.
- [ ] Add `serialize()` / `fromSnapshot()` round trips first to `FmIndexBytes`,
      `WaveletMatrixUint8/Uint32`, `StaticMphfBytes/U32`, `CompressedStringTable`,
      `EliasFanoSequence`, and `BinaryVectorIndex`.
- [ ] Verify that restoration reproduces query results without rerunning the builder and that
      deserialization releases partial allocations on failure.
- [ ] Measure snapshot bytes, load time, peak RSS, and IndexedDB/file/Worker-friendly copy costs.

Construction is excluded from many resident benchmarks. Persistence is therefore necessary for
applications that build once and query across multiple process or page lifetimes. Do not promise
cross-version stability until the envelope and compatibility policy are explicitly documented.

#### 5. Prototype a shared column selection mask

- [ ] Define the common logical operations required by adaptive and bit-sliced columns: clear, fill,
      count, `and`, `or`, `andNot`, invert, and typed position output.
- [ ] Prototype `AdaptiveSimdColumnI32` and `BitSlicedColumnU8` sharing one Wasm memory and one mask
      layout under a possible `column` entrypoint.
- [ ] Reject a TypeScript-only common interface if combining masks still copies complete bitmaps
      between independent Wasm memories.
- [ ] Retain the combined entrypoint only if a multi-column predicate workload beats materialized
      JavaScript masks after including its larger bundle.

The goal is to support queries such as `age.between(...).and(status.eq(...))` without copying an
intermediate selection back through JavaScript.

#### 6. Add explicit mutable-to-frozen bridges

- [ ] Evaluate `Bitmap -> BitVector`, `ByteKeyFlatHashMapU32 -> FrozenByteMapU32`, and monotone
      builder -> Elias–Fano / PackedDelta conversion helpers.
- [ ] Make rebuild and ownership costs explicit; a `freeze` operation may construct a new physical
      representation rather than alias mutable storage.
- [ ] Avoid a runtime factory that hides representation-specific operations or bundle costs.

### P2: New entrypoints after P0/P1

#### 7. Prototype `BlockedBloomFilter`

- [ ] Use a cache-local logical block represented by a small fixed number of `v128` values.
- [ ] Design `addMany`, `mayContainMany`, and `merge` before adding point methods.
- [ ] Compare false-positive rate, bytes/key, build time, and bulk negative lookup against a scalar
      typed-array Bloom filter and exact set alternatives.
- [ ] Connect the benchmark to an existing exact structure such as a byte hash table or static MPHF;
      reject it if the filter does not improve the end-to-end negative-lookup workload.

JavaScript has no builtin approximate-membership structure, making this the strongest genuinely new
candidate after the existing contracts are complete.

#### 8. Evaluate type-specialized follow-ups only with a workload

- [ ] Benchmark `AdaptiveSimdColumnU32` for unsigned range predicates and aggregates.
- [ ] Benchmark `WaveletMatrixUint16` for UTF-16/code-unit data and compact category columns against
      the existing Uint32 implementation.
- [ ] Add `squaredDistance`, norm, cosine similarity, and batched dot operations to
      `SimdFloat32Vector` before considering another Float32 container type.

Do not add `SimdFloat32Array`, `SimdInt32Vector`, or other symmetric names without first showing an
operation that wins after boundary and copy costs.

### Canonical names

Documentation and new examples use only these canonical subpaths:

- `bitmap`
- `bit-vector`
- `roaring-bitmap`

`bitset`, `rank-select-bitvector`, `rank-select-bitmap`, and `roaring-uint32-set` remain
compatibility aliases for now. Keep them out of the primary guide, mark them deprecated in API
documentation, and decide their removal policy before 1.0 rather than adding further aliases.

## Succinct-data-structure support boundary

The 2011 JSAI overview organizes succinct structures around sets, strings, trees, and graphs, and
specifically points to rank/select dictionaries, wavelet trees, LOUDS/XBW tries, succinct
associative arrays, FM-indexes, compressed suffix arrays, compressed arrays, and wavelet-tree graph
indexes. This project will cover that space selectively rather than attempting to reproduce a
general C++ library such as SDSL.

| article family               | decision            | `jsimd` surface                                                        |
| :--------------------------- | :------------------ | :--------------------------------------------------------------------- |
| bitvector rank/select        | support             | `BitVector`; Elias–Fano supplies a sparse monotone variant             |
| integer sequences / arrays   | support selectively | `EliasFanoSequence`, `PackedDeltaUint32List`, `WaveletMatrixUint32`    |
| byte strings / wavelet tree  | support             | `WaveletMatrixUint8`, specialized to 8 levels rather than 32           |
| succinct associative arrays  | support             | `StaticMphfBytes` plus frozen byte arena and optional `u32` values     |
| compressed full-text search  | support             | `FmIndexBytes` with batched count and sampled locate                   |
| succinct tree topology       | reject for now      | LOUDS bulk parent lost by 6.70x to a direct `Uint32Array`              |
| succinct trie / XBW          | do not expose now   | Previous trie prototype lost exact and prefix lookup to JavaScript     |
| CSA / compressed suffix tree | no standalone type  | Add only as an internal FM-index extension after `locate` measurements |
| DAG-compressed array         | defer               | Pointer chasing has no demonstrated Wasm SIMD advantage                |
| graph-indexing wavelet tree  | defer               | Too application-specific; retain `BitMatrix` as the general primitive  |

This makes byte-oriented static search the next coherent layer:

1. `ByteKeyFlatHashMapU32` is retained as the mutable baseline and StringInterner building block:
   bulk lookup was 2.00x faster, while point lookup was 12.5x slower than native Map.
2. `StaticMphfBytes` / frozen byte map is the direct succinct-associative-array target; the mutable
   table is not itself succinct.
3. `WaveletMatrixUint8` avoids the 32 levels of the general Uint32 matrix and is an acceptable
   byte-string representation.
4. `FmIndexBytes` combines a BWT, byte wavelet matrix, cumulative symbol counts, and bitvector-
   sampled suffix-array positions. Its repeated count workload won; construction and size remain
   explicit trade-offs.
5. The topology-only LOUDS prototype was not retained: `Uint32Array` parent lookup was 6.70x faster.
   Its benchmark remains under `experiments/louds-topology/` as rejection evidence.

The mutable byte map and string interner remain typed utility structures, but they do not count as
succinct coverage. Likewise, `WaveletMatrixUint32` covers general integer sequences but does not
replace an 8-level byte implementation for BWT/FM-index storage.

Sources:
[JSAI, “Succinct Data Structures”](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/),
[SDSL's implemented structure families](https://github.com/simongog/sdsl-lite), and the
[FM-index authors' project page](https://people.unipmn.it/manzini/fmindex/).

## Implementation history and remaining experiments

### 1. Packed integer layouts

- [x] Prototype `PackedUint32Array` with 0–32-bit random access, batched gather, and SIMD decode
      paths for 8/16/32-bit payloads.
- [x] Prototype a 128-value `base + bit-packed offset` FOR+BP128 successor to
      `PackedDeltaUint32List` with lower-bound, decode, and intersection.
- [x] Compare the prototypes with `Uint32Array` and the existing Stream VByte implementation.
- [x] Reject both public entrypoints after the measured kernels failed to win a latency workload.

The rejected prototypes were tested on Apple M5 / Node 24.12 / Vitest 4.1.11 with construction
excluded and reusable outputs. For 262,144 values, an 8-bit `PackedUint32Array` full decode was
3.35x slower than `Uint32Array#set`, and its 4,096-value gather was 8.26x slower than direct typed
array access. A 13-bit generic decode was 31.2x slower than `set`.

The FOR+BP128 prototype used one base and one fixed width per 128-value block. On an arithmetic
postings list it improved 1,024 lower bounds by 1.38x over the Stream VByte implementation and used
about 1.20 bytes/value rather than 1.31, but was still 2.13x slower than binary search over a
`Uint32Array`. Full decode was 33.4x slower than typed-array copy and 1.58x slower than Stream
VByte; intersection was 3.95x slower than the typed-array merge and 2.31x slower than Stream VByte.
The prototype source and entrypoints were removed rather than adding uncompetitive bundle cost.

Revisit bit packing only as an internal encoding required by `AdaptiveSimdPageI32`, or when a
general-width SIMD unpack design has a credible end-to-end workload. Do not restore a standalone
`PackedUint32Array` for storage savings alone; `Uint8Array`, `Uint16Array`, and application-specific
packed formats cover the common widths without a Wasm boundary.

Elias–Fano remains the compressed random-query representation and Stream VByte remains the compact
sequential/intersection experiment.

Reference: [Techniques for Inverted Index Compression](https://arxiv.org/html/1908.10598v2)

### 2. Shared monotone contract

- [x] Reject a runtime `MonotoneUint32Sequence` wrapper/factory. Elias–Fano exposes rank and full
      decode while PackedDelta exposes lower-bound and ranged decode; forcing one runtime surface
      would hide the encoding-specific operations without creating a new SIMD kernel. TypeScript
      callers can use a structural `{ length; at(index); nextGEQ(value) }` contract at zero bundle
      cost when that smaller common surface is sufficient.
- [x] Add partitioned Elias–Fano after clustered blocks showed meaningful local structure. Strict
      contiguous blocks use no payload; other blocks use a base-adjusted local Elias–Fano. On the
      clustered benchmark, 1,024 ranks were 11.22x faster than global EF and 2.49x faster than typed
      array lower bounds. The gain is data-dependent and metadata can hurt uniform distributions.

### 3. Adaptive columnar pages

- [x] Add a multi-page column with page-level ZoneMap pruning; the existing page already stores
      `min` and `max`.
- [ ] Add `RangeFilterU32` only if measured ZoneMap false positives justify its storage.
- [ ] Evaluate Delta, RLE, Dictionary, Sparse, and BitSliced page encodings independently.
- [x] Keep selection masks resident across multi-page `scan`, `aggregate`, and `gather` operations.
- [ ] Reuse `BitSlicedColumn` inside an adaptive page only if it avoids another Wasm module or a
      full mask copy.

Each new encoding must beat Constant/FOR/Raw on an end-to-end page workload, not merely compress a
synthetic payload.

References: [MorphStore](https://arxiv.org/html/2004.09350v1),
[ZipFlow](https://arxiv.org/html/2602.08190v1), [bloomRF](https://arxiv.org/html/2207.04789v2)

### 4. BitMatrix and graph kernels

- [x] `BitMatrix`: resident dense rows, transpose, boolean multiplication, and row views.
- [x] Compare the retained dense kernel with scalar `Uint32Array`: a 512×512 Boolean square was
      6.56x faster including transpose and result allocation.
- [x] Add frozen CSR rows as `SparseBitMatrix` for large sparse matrices.
- [x] Prototype and reject CSR reachability: at 16K vertices and degree four it took 0.209 ms versus
      0.123 ms for a direct JavaScript adjacency BFS (JS 1.70x faster). No traversal API is exposed.
- [ ] Keep `SemiringGraph` deferred until it can reuse a measured `BitMatrix` or sparse-row layout.

Reference: [SlimSell](https://arxiv.org/abs/2010.09913)

### 5. Typed hash and string derivatives

- [x] `FingerprintGroup16`: standalone 16-byte control group with fingerprint, empty, deleted,
      available, and batched masks. Retained for 1.60x faster bulk probes; individual probes were
      1.22x slower than JavaScript.
- [x] `FingerprintTable16`: contiguous power-of-two control groups and batched primary-group
      selection. Returning group offsets and all masks was 4.91x faster than JavaScript.

- [x] `FlatHashMapU64U32` for BigInt IDs, hashes, and packed coordinates. Batched 131,072-query
      lookup was 11.96x faster than `Map<bigint, number>`; point operations retain boundary costs.
- [x] `FlatHashMapFixed16U32` and `FlatHashSetFixed16` for UUID or fixed-hash keys. Batched lookup
      was 25.6–27.9x faster than pre-stringified native `Map`/`Set` in the recorded workload.
- [x] Retain `ByteKeyFlatHashMapU32` as a measured mutable baseline: bulk lookup won by 2.00x, while
      point lookup lost by 12.5x.
- [x] `StaticMphfBytes` plus a frozen byte arena and exact-key membership policy. It is 13.5x faster
      than per-query hex encoding plus `Set`, but 2.26x slower than a pre-encoded `Set<string>`.
- [x] `CompressedStringTable` using block-local front coding. The recorded path corpus used 31.0% of
      raw bytes; equality beat scalar bytes by 2.00x, while random decode lost by 12.3x.
- [x] Reject `StringInterner`: native `Map<string, u32>` already provides exact decoded-string
      interning, while the measured byte map is 12.5x slower for point lookup before UTF-8 copying.
- [x] `WaveletMatrixUint8` with 8 levels, byte-oriented bulk rank, and BWT-ready storage.
- [x] `FmIndexBytes.countMany` and bitvector-sampled `locateMany`; count was 6.86x faster than the
      overlapping `String#indexOf` workload. Locating 233,657 positions took 324.8 ms, so count and
      cap results first.

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
- [x] Add `PdxFloat32Index`: a 16K × 64 exact L2 scan was 6.46x faster than a scalar `Float32Array`
      loop.
- [x] Add `BinaryVectorIndexWithRerank` to refine a caller-chosen Hamming candidate count with exact
      PDX L2. Recall remains controlled by `candidateCount`; benchmark application-specific recall
      before reducing it.

References: [PDX vector layout](https://arxiv.org/html/2503.04422),
[QuIVer](https://arxiv.org/html/2605.02171v3)

## Deferred candidates

These remain below the queue until a concrete workload suggests an advantage over JavaScript or an
established library:

- `SimdPriorityQueue`
- `SimdOrderedIndex`
- `MortonSpatialIndex`
- `UltraLogLog`
- `BitHistogram32`

`BlockedBloomFilter` moved to the user-facing completion queue. It remains behind the existing API,
persistence, and composition work rather than being treated as the immediate next implementation.

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
