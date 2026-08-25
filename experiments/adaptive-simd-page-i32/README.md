# AdaptiveSimdPageI32 experiment

This benchmark compares a 256-row adaptive page against an `Int32Array` loop that produces the same
selection mask and count. It covers Constant, 10-bit frame-of-reference, and wide Raw pages, plus
sum and full materialization.

The committed results show that Constant metadata fast paths and Raw SIMD scans/reductions win. FOR
sum wins while FOR predicate scan loses to JavaScript because unpacking dominates at this page size.
Native typed-array copy remains much faster than decoding either stored representation.

See the [entrypoint README](../../src/adaptive-simd-page-i32/README.md) for numbers, interpretation,
standalone build size, and sources.

```sh
pnpm bench:adaptive-simd-page-i32
pnpm bench:record:adaptive-simd-page-i32
pnpm bench:compare:adaptive-simd-page-i32
```
