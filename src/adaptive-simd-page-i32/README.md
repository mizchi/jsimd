# AdaptiveSimdPageI32

An immutable page of up to 256 signed 32-bit integers. Construction inspects the local value range
and chooses one physical representation:

| encoding             | selection rule          | logical payload                   |
| :------------------- | :---------------------- | :-------------------------------- |
| `constant`           | every value is equal    | zero bytes; the value is metadata |
| `frame-of-reference` | range fits in 1–16 bits | packed unsigned deltas from `min` |
| `raw`                | wider local range       | four bytes per value              |

```ts
import { AdaptiveSimdPageI32, SimdPageMask } from "@mizchi/jsimd/adaptive-simd-page-i32";

using page = AdaptiveSimdPageI32.from([-3, 1, 4, 1, 5, 9, 2, 6]);
using selected = new SimdPageMask(page.length);
using lowValues = new SimdPageMask(page.length);

page.scanBetween(1, 6, selected); // half-open [1, 6)
page.scanLt(3, lowValues);
selected.andAssign(lowValues);
selected.toIndices(); // Uint32Array [1, 3, 6]

const output = new Int32Array(selected.countOnes());
page.gatherInto(selected, output); // [1, 1, 2]

page.sum();
page.min;
page.max;
page.encoding;
page.encodedBytes;
```

Bind both pages and masks with `using`. Their payload and intermediate selection words stay in the
same Wasm memory, and scope exit returns both allocations to a reuse pool. `scanEq`, `scanLt`, and
`scanBetween` overwrite an existing mask instead of allocating a result. Mask `andAssign`,
`orAssign`, `differenceAssign`, and `invert` execute over 128-bit blocks.

`decodeInto` and `gatherInto` copy final values back to JavaScript. Keep filtering and mask
composition resident until that final materialization step.

## Layout and algorithm

Each page records a ZoneMap (`min` and `max`). Impossible predicates return an empty mask without
reading the payload, and predicates covering the complete page return a full mask. Constant pages
also answer `sum` from metadata.

Frame-of-reference (FOR) stores `value - min` at the smallest fixed width that covers the page's
range. SIMD scan kernels unpack four values, add the signed base, compare with `i32x4`, and write
the four-lane bitmask into the resident selection mask. Raw scans load four `i32` values directly.
`sum` uses wide `i64` accumulation, so it does not silently wrap at 32 bits.

The page is frozen at construction. This initial version deliberately excludes Delta, RLE,
Dictionary, Sparse, and BitSliced encodings. Each will be added only if its build size and
end-to-end page workload beat these three forms.

The adaptive compressed-operator direction follows
[MorphStore](https://arxiv.org/html/2004.09350v1), which keeps intermediate data compressed across
operators. The broader per-block encoding-selection direction is also explored by
[ZipFlow](https://arxiv.org/html/2602.08190v1). This implementation is a small Wasm-oriented page,
not a compatible implementation of either system.

## Performance characteristics

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Every case contains 256 values; construction is
excluded. Predicate timings include producing a selection mask and counting it.

| encoding / operation | adaptive | `Int32Array` JS | relative result |
| :------------------- | -------: | --------------: | :-------------- |
| Constant range scan  |  0.13 us |         0.47 us | 3.7x faster     |
| Constant sum         |  0.02 us |         0.84 us | 44x faster      |
| FOR range scan       |  0.55 us |         0.29 us | 1.9x slower     |
| FOR sum              |  0.39 us |         0.78 us | 2.0x faster     |
| Raw range scan       |  0.18 us |         0.24 us | 1.3x faster     |
| Raw sum              |  0.07 us |         0.85 us | 11x faster      |

This is not always faster than JavaScript. FOR saves space—320 bytes for the benchmark's 10-bit page
instead of 1,024 bytes—but unpacking makes its small-page range scan slower than an optimized JS
loop. Use FOR when resident size or repeated aggregates matter, not as a universal scan-speed
replacement.

Materialization is also a trade-off. Native typed-array copy took about 0.03 us. FOR decode took
about 0.57 us (roughly 17x slower), and raw `decodeInto` took about 0.15–0.27 us because it crosses
Wasm memory before copying into the caller's array. If the workload primarily reads or copies all
values, retain an `Int32Array` instead.

```sh
pnpm bench:adaptive-simd-page-i32
pnpm bench:record:adaptive-simd-page-i32
pnpm bench:compare:adaptive-simd-page-i32
```

## Standalone build size

The isolated Vite fixture emits one 1.84 kB Wasm asset (0.83 kB gzip) and a 10.37 kB minified JS
wrapper (3.72 kB gzip). It does not emit the Wasm for `SimdInt32Array`, `BitSlicedColumn`, or any
other entrypoint.

Vitest baseline JSON and benchmark sources live in
[`experiments/adaptive-simd-page-i32`](../../experiments/adaptive-simd-page-i32).

Files:

- `mod.ts`: encoding selection, public page/mask contracts, ZoneMap pruning, and ownership
- `kernels.wat`: packed decode, raw/FOR scans, reductions, gather, and mask kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated by `wasm-tools strip`, validated, and Git-ignored
