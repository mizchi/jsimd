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
| `ByteKeyFlatHashMapU32`                | active   | Mutable byte arena and SIMD candidate verification               |
| `FingerprintGroup16/Table16`           | complete | SwissTable masks; multi-group batch probes are 4.91x faster      |
| `BitSlicedColumnU8`                    | complete | Nullable predicates and resident composable masks                |
| `BitMatrix`                            | complete | Dense rows, non-owning views, transpose, and Boolean product     |
| `WaveletMatrixUint32`                  | complete | Access, rank/select, range frequency, quantile, and predecessor  |
| `EliasFanoSequence`                    | complete | Compressed monotone access, rank, neighbors, and bulk decode     |
| `AdaptiveSimdPageI32`                  | complete | Constant, FOR, or Raw pages with scans, masks, gather, and sum   |
| `StaticMphfU32`                        | complete | Frozen dense IDs, fingerprints, and batched lookup               |
| `BinaryVectorIndex`                    | complete | Resident binary signatures and exhaustive Hamming scans          |
| `SuccinctTrie`                         | rejected | Prototype lost exact lookup and prefix queries to JavaScript     |
| `PackedUint32Array`                    | rejected | Compact payload, but decode and gather lost to typed arrays      |
| `PackedDeltaArray` (FOR+BP128)         | rejected | Smaller blocks did not offset unpack and query costs             |

New entrypoints must justify both their Wasm boundary and their independently tree-shaken bundle
cost.

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
| byte strings / wavelet tree  | add                 | `WaveletMatrixUint8`, specialized to 8 levels rather than 32           |
| succinct associative arrays  | add                 | `StaticMphfBytes` plus frozen byte arena and optional `u32` values     |
| compressed full-text search  | add                 | `FmIndexBytes` with batched `countMany` first, sampled `locate` second |
| succinct tree topology       | conditional         | Prototype `LoudsTree` or balanced-parentheses bulk navigation only     |
| succinct trie / XBW          | do not expose now   | Previous trie prototype lost exact and prefix lookup to JavaScript     |
| CSA / compressed suffix tree | no standalone type  | Add only as an internal FM-index extension after `locate` measurements |
| DAG-compressed array         | defer               | Pointer chasing has no demonstrated Wasm SIMD advantage                |
| graph-indexing wavelet tree  | defer               | Too application-specific; retain `BitMatrix` as the general primitive  |

This makes byte-oriented static search the next coherent layer:

1. Finish and measure `ByteKeyFlatHashMapU32` as the mutable baseline and StringInterner building
   block; remove it if bulk lookup does not beat pre-encoded native string keys.
2. Implement `StaticMphfBytes` / frozen byte map. This is the direct succinct-associative-array
   target; the mutable table is not itself succinct.
3. Implement `WaveletMatrixUint8`. The current Uint32 matrix always stores 32 bit levels and is not
   an acceptable byte-string representation.
4. Build `FmIndexBytes` from a BWT, byte wavelet matrix, cumulative symbol counts, and optional
   sampled suffix-array positions. Compare repeated pattern batches with `Uint8Array` and string
   search, including index construction and encoded size separately.
5. Revisit only the topology layer of LOUDS or balanced parentheses. Retain it only if bulk
   `parentMany`, `childrenMany`, or subtree navigation wins a concrete AST/dictionary workload.

The mutable byte map and string interner remain typed utility structures, but they do not count as
succinct coverage. Likewise, `WaveletMatrixUint32` covers general integer sequences but does not
replace an 8-level byte implementation for BWT/FM-index storage.

Sources:
[JSAI, “Succinct Data Structures”](https://www.ai-gakkai.or.jp/resource/my-bookmark/my-bookmark_vol26-no6/),
[SDSL's implemented structure families](https://github.com/simongog/sdsl-lite), and the
[FM-index authors' project page](https://people.unipmn.it/manzini/fmindex/).

## Next implementation queue

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

- [x] `BitMatrix`: resident dense rows, transpose, boolean multiplication, and row views.
- [x] Compare the retained dense kernel with scalar `Uint32Array`: a 512×512 Boolean square was
      6.56x faster including transpose and result allocation.
- [ ] Compare dense rows with Roaring or CSR storage before supporting large sparse matrices.
- [ ] Add reachability or BFS kernels only after the storage choice wins a real dependency-graph
      workload.
- [ ] Keep `SemiringGraph` deferred until it can reuse a measured `BitMatrix` or sparse-row layout.

Reference: [SlimSell](https://arxiv.org/abs/2010.09913)

### 5. Typed hash and string derivatives

- [x] `FingerprintGroup16`: standalone 16-byte control group with fingerprint, empty, deleted,
      available, and batched masks. Retained for 1.60x faster bulk probes; individual probes were
      1.22x slower than JavaScript.
- [x] `FingerprintTable16`: contiguous power-of-two control groups and batched primary-group
      selection. Returning group offsets and all masks was 4.91x faster than JavaScript.

- [ ] `FlatHashMapU64U32` only with a real 64-bit-key workload.
- [x] `FlatHashMapFixed16U32` and `FlatHashSetFixed16` for UUID or fixed-hash keys. Batched lookup
      was 25.6–27.9x faster than pre-stringified native `Map`/`Set` in the recorded workload.
- [ ] Finish benchmarking `ByteKeyFlatHashMapU32`; retain it only as a measured mutable baseline.
- [ ] `StaticMphfBytes` plus a frozen byte arena and exact-key or fingerprint membership policy.
- [ ] `CompressedStringTable` using front coding, FSST, or OnPair16; compare against an ordinary
      byte arena before adding compression.
- [ ] `StringInterner` with `u32` handles only if bulk lookup amortizes UTF-8 copying.
- [ ] `WaveletMatrixUint8` with 8 levels, byte-oriented bulk rank, and BWT-ready storage.
- [ ] `FmIndexBytes.countMany`; add sampled `locateMany` only after count and size benchmarks pass.

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
