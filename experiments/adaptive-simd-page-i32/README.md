# AdaptiveSimdPageI32 experiment

This benchmark compares a 256-row adaptive page against an `Int32Array` loop that produces the same
selection mask and count. It covers Constant, four-run RLE, four-value Dictionary, a 32-exception
Sparse page, 10-bit frame-of-reference, and wide Raw pages. Each case also measures sum, gather,
full materialization, and construction.

The committed results show that Constant metadata fast paths, RLE, Dictionary, and Sparse resident
scans/aggregates, and Raw SIMD scans/reductions win. FOR sum wins while FOR predicate scan loses to
JavaScript because unpacking dominates at this page size. Native typed-array copy remains much
faster than decoding compressed representations.

See the [entrypoint README](../../packages/jsimd/src/adaptive-simd-page-i32/README.md) for numbers,
interpretation, standalone build size, and sources.

```sh
pnpm bench:adaptive-simd-page-i32
pnpm bench:record:adaptive-simd-page-i32
```
