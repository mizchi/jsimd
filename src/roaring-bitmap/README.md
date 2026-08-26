# RoaringBitmap

A mutable, Wasm-resident Roaring-style set for unsigned 32-bit integers. The high 16 bits select a
container. The low 16 bits use a sorted `Uint16` array through 4,096 values and an 8 KiB bitmap from
4,097 values onward.

```ts
import { RoaringBitmap } from "@mizchi/jsimd/roaring-bitmap";

using active = RoaringBitmap.from([1, 10, 65_536, 0xffff_ffff]);
using selected = RoaringBitmap.from([10, 65_536, 70_000]);

active.has(0xffff_ffff); // true
active.andCardinality(selected); // 2, without creating an intersection
active.orCardinality(selected); // 5
active.intersects(selected); // true, stops at the first matching value
active.jaccard(selected); // 2 / 5

using intersection = new RoaringBitmap();
active.andInto(selected, intersection);
intersection.toUint32Array(); // [10, 65536]

using union = active.or(selected);
using difference = active.andNot(selected);
using symmetricDifference = active.xor(selected);

const queries = new Uint32Array([1, 2, 10, 65_536]);
const matches = new Uint8Array(queries.length);
active.hasMany(queries, matches); // [1, 0, 1, 1]

const values = new Uint32Array(active.size);
active.valuesInto(values);
```

Mutation and inclusive range iteration are also available:

```ts
active.insert(11).insert(12).remove(1);
active.forEachRange((start, end) => {
  console.log(start, end);
});
```

The reusable `andInto`, `orInto`, `xorInto`, and `andNotInto` forms must not alias either input.
Every owning set should be declared with `using`; scope exit returns all of its array and bitmap
container allocations via `Symbol.dispose`. `hasMany` accepts arbitrary query order, but sorted or
high-key-grouped queries avoid repeated container searches.

This first version implements the canonical array and bitmap containers and dynamically converts at
the 4,096/4,097 boundary. Run containers and portable Roaring serialization are not implemented yet,
so this is not currently a drop-in wire-format replacement for CRoaring or RoaringBitmap libraries.

## Design source

The upper-16-bit partitioning, 4,096-element array/bitmap threshold, and container-wise set algebra
follow
[“Roaring Bitmaps: Implementation of an Optimized Software Library”](https://arxiv.org/html/1709.07821v6).
This first jsimd version omits run containers and portable serialization, and specializes the dense
container kernels for Wasm `v128`.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Resident operations reuse their output;
construction is measured separately. `hasMany` uses sorted queries. Times are means.

| workload                      | operation        |  Roaring | sorted `Uint32Array` | `Set<number>` |
| :---------------------------- | :--------------- | -------: | -------------------: | ------------: |
| 16 dense bitmap containers    | construction     |  7.66 ms |              21.5 us |       8.11 ms |
| 16 dense bitmap containers    | `andCardinality` |   6.7 us |              1.17 ms |       2.07 ms |
| 16 dense bitmap containers    | `orInto`         |  11.3 us |             649.8 us |       8.69 ms |
| 16 dense bitmap containers    | `xorInto`        |   9.0 us |             546.1 us |      13.37 ms |
| 16 dense bitmap containers    | `andNotInto`     |   9.1 us |             516.9 us |       8.16 ms |
| 16 dense bitmap containers    | `hasMany`        | 211.7 us |                    — |       1.38 ms |
| 1,024 sparse array containers | construction     |  2.66 ms |               6.2 us |       1.19 ms |
| 1,024 sparse array containers | `andCardinality` |  37.0 us |             378.2 us |      442.2 us |
| 1,024 sparse array containers | `orInto`         | 736.4 us |             145.6 us |       1.79 ms |
| 1,024 sparse array containers | `xorInto`        | 654.6 us |             140.9 us |       2.62 ms |
| 1,024 sparse array containers | `andNotInto`     | 631.6 us |             134.4 us |       1.04 ms |
| 1,024 sparse array containers | `hasMany`        | 217.8 us |                    — |      594.6 us |

Dense materializing set algebra is the strongest SIMD case: a bitmap pair is processed with
`v128.or`, `v128.xor`, or `v128.andnot` plus `i8x16.popcnt`. Non-materializing cardinality is also
strong for both layouts. Sparse materialization beats `Set`, but is about 4.6–5.1x slower than an
already-sorted `Uint32Array` merge; sparse construction is also slower than `Set`. Prefer sorted
typed arrays when data is already ordered and does not need mutation, adaptive containers, or
repeated dense set algebra.

```sh
pnpm bench:roaring-bitmap
pnpm bench:record:roaring-bitmap
pnpm bench:compare:roaring-bitmap
```

## Standalone build size

The isolated Vite fixture emits one 1.31 kB Wasm asset (0.53 kB gzip) and a 13.91 kB minified JS
wrapper (4.72 kB gzip). The larger wrapper contains container ownership, conversion, and high-key
routing; tree-shaking still excludes every unrelated jsimd Wasm module.

See [`experiments/roaring-bitmap`](../../experiments/roaring-bitmap/README.md) for recorded results.

Files:

- `mod.ts`: public API, high-key metadata, container conversion, and ownership
- `kernels.wat`: SIMD bitmap set algebra and array/bitmap intersection kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated binary; stripped, validated, and Git-ignored
