# Implementation TODO

This file is the actionable queue for `@mizchi/jsimd`. Completed APIs, algorithms, sources,
benchmarks, trade-offs, and standalone build sizes belong in each feature README under
`src/<name>/`. Rejected prototypes keep their evidence under `experiments/<name>/`; implementation
history does not belong in this queue.

## Next: `WaveletMatrixUint16`

- [ ] Define UTF-16/code-unit and compact-category workloads before copying the Uint8/Uint32 APIs.
- [ ] Compare an actual 16-level implementation with `WaveletMatrixUint32`, `Uint16Array`, and
      binary-search/count baselines.
- [ ] Retain only operations whose reduced level count amortizes construction and the Wasm boundary.

## Queue

### P2: workload-driven specializations

- [ ] Add squared distance, norm, cosine similarity, and batched dot to `SimdFloat32Vector` before
      considering another Float32 container.
- [ ] Evaluate additional adaptive-page encodings independently: Delta, RLE, Dictionary, Sparse, and
      BitSliced.

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
- `BitHistogram32`

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
