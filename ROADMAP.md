# Data structure roadmap

Implementation order after the initial byte, numeric, bitset, and matrix kernels:

1. ✅ `RankSelectBitVector` — build/freeze rank, select, and neighboring-bit foundation
2. ✅ `RoaringUint32Set` — mutable compressed integer sets and non-materializing set queries
3. ✅ `PackedDeltaUint32List` — frozen Stream VByte sorted integer lists and bulk intersection
4. ✅ `SimdFlatHashMap/Set` — typed-key SwissTable-style control groups and bulk probing
5. ✅ `BitSlicedColumn` — mostly-static predicates producing composable resident bit masks
6. ✅ `WaveletMatrixUint32` — static range frequency, quantile, and predecessor queries
7. `EliasFanoSequence` — compact monotone random access, rank, and predecessor

`RankSelectBitVector` is the first foundation because Roaring, bit-sliced indexes, wavelet matrices,
and future succinct structures can reuse its block layout and query contracts. APIs should favor
complete or batched operations over exposing SIMD lanes across the JavaScript boundary.

Later candidates are `BlockedBloomFilter`, `SimdPriorityQueue`, and `SimdOrderedIndex`. They remain
below the first six until benchmarks show a WebAssembly SIMD advantage over relevant JavaScript
builtins or established libraries.

See [`TODO.md`](./TODO.md) for concrete APIs, implementation checklists, research-derived build
tracks, and benchmark gates.
