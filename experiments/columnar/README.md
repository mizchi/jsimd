# Columnar benchmark

This benchmark is the admission gate for `@mizchi/jsimd/columnar`. Its shared-mask case evaluates
one i32 range and one u8 equality over 4,194,304 rows, composes both predicates, and counts selected
rows.

The retained implementation keeps both columns and both selection masks in one Wasm memory. It is
compared with both relevant JavaScript baselines:

- one fused loop over the original `Int32Array` and `Uint8Array`;
- two independently materialized packed JS masks followed by AND and popcount.

It also admits `AdaptiveU32Column` against an indexed `Uint32Array` loop in two distributions:

- locally clustered high-bit values, where page ZoneMaps prune most payloads;
- random raw pages, where every page must execute unsigned SIMD comparisons.

Both baselines materialize the same packed mask and count the same rows. An exploratory u32 sum was
removed after taking 5.55 ms versus 2.26 ms for JavaScript; it is not part of the retained baseline.

Construction and final position materialization are excluded because the intended workload freezes
columns once and executes repeated filters. See
[`src/columnar/README.md`](../../src/columnar/README.md) for measured results, limits, and build
size.

```sh
pnpm bench:columnar
pnpm bench:record:columnar
pnpm bench:compare:columnar
```
