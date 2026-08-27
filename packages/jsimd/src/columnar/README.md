# Columnar

`columnar` combines adaptive signed and unsigned 32-bit pages with bit-sliced unsigned-byte columns
in one Wasm module. All column types write into the same `SelectionMask` layout, so predicates from
different columns can be composed without copying intermediate masks through JavaScript.

```ts
import {
  AdaptiveI32Column,
  AdaptiveU32Column,
  BitSlicedU8Column,
  SelectionMask,
} from "@mizchi/jsimd/columnar";

using prices = AdaptiveI32Column.from(Int32Array.of(100, 220, 180, 310));
using ids = AdaptiveU32Column.from(Uint32Array.of(0xffff_ff00, 20, 30, 0xffff_ff10));
using kinds = BitSlicedU8Column.from(Uint8Array.of(1, 2, 2, 1), 2);
using selected = new SelectionMask(prices.length);
using temporary = new SelectionMask(prices.length);

prices.scanBetween(150, 300, selected); // half-open [150, 300)
kinds.scanEq(2, temporary);
selected.andAssign(temporary);
ids.scanLt(0x8000_0000, temporary); // unsigned comparison
selected.andAssign(temporary);
const output = new Uint32Array(selected.countOnes());
ids.gatherInto(selected, output); // output is [20, 30]
```

Declare every owning column and mask with `using`. Scope exit returns its linear-memory allocation
to the module's shared reuse pool. Predicate methods overwrite their output mask. Keep selections
resident through `andAssign`, `orAssign`, `andNotAssign`, and `invert`; call `countOnes`,
`positionsInto`, or `toIndices` only when JavaScript needs the result.

`gatherInto` materializes selected values in row order through one bulk Wasm call per internal page.
It enumerates sparse mask words with `ctz`, avoiding one JS/Wasm call per value. For nullable
`BitSlicedU8Column`, pass a second `Uint8Array` to receive byte-per-row validity; null values are
written as zero. Caller-owned outputs must have room for `selection.countOnes()` values.

All three frozen columns can be persisted without rebuilding their encodings:

```ts
const snapshot = prices.serialize();
using restored = AdaptiveI32Column.fromSnapshot(snapshot);
```

Snapshots use a checksummed, versioned little-endian envelope and validate page metadata, ZoneMaps,
padding, and payload bounds before allocating resident storage.

## Layout

`AdaptiveI32Column` and `AdaptiveU32Column` split values into fixed 256-row pages. Each page has a
ZoneMap (`min`, `max`) and chooses one frozen representation:

| encoding           | condition                  | payload                         |
| :----------------- | :------------------------- | :------------------------------ |
| constant           | all page values are equal  | metadata only                   |
| frame-of-reference | local range fits 1–16 bits | bit-packed `value - min` deltas |
| raw                | wider local range          | four bytes per value            |

ZoneMaps answer empty or full-page predicates without scanning payload. Partial raw and FOR pages
use signed `i32x4` comparisons for i32 and `i32x4.lt_u` / `i32x4.ge_u` for u32. Equality uses the
same bit representation. `BitSlicedU8Column` stores one bitmap per value bit plus a validity bitmap;
one `v128` evaluates 128 rows at a time. It accepts an optional byte-per-row validity input, where
zero represents null. All column types use half-open ranges `[minimum, maximum)`.

The adaptive compressed-operator direction follows
[MorphStore](https://arxiv.org/html/2004.09350v1). The vertical bit-sliced layout follows the
bit-sliced index described by
[O'Neil and Quass, “Improved Query Performance with Variant Indexes”](https://doi.org/10.1145/253260.253268)
and is related to [Li and Patel, “BitWeaving”](https://www.microsoft.com/en-us/research/?p=215048).
This is a compact Wasm-v128-specific implementation, not a compatible port of those systems.

## Performance characteristics

Recorded with Vitest 4.1.11 / Node 24 / Apple M5 over 4,194,304 rows. Construction and final row-ID
materialization are excluded. The shared-mask case evaluates an i32 range and a u8 equality. The u32
cases produce a packed selection mask and return its count.

| implementation                          |     mean | relative to columnar |
| :-------------------------------------- | -------: | -------------------: |
| shared Wasm columns + mask AND + count  | 0.159 ms |                1.00x |
| fused JS typed-array loop + count       | 3.488 ms |         21.9x slower |
| two materialized JS masks + AND + count | 6.451 ms |         40.5x slower |

Unsigned specialization is measured separately because signed `i32x4` comparisons are incorrect
above `0x7fff_ffff`.

| u32 range workload                        | columnar | `Uint32Array` JS | result        |
| :---------------------------------------- | -------: | ---------------: | :------------ |
| locally clustered FOR pages with ZoneMaps | 0.107 ms |         3.514 ms | 32.69x faster |
| random raw pages without ZoneMap pruning  | 1.669 ms |         4.816 ms | 2.89x faster  |

This entrypoint is not always faster than JavaScript. Building either frozen layout is extra work; a
one-shot query should remain a fused typed-array loop. Point reads cross the JS/Wasm boundary, FOR
decoding adds work, and small columns can be dominated by call overhead. The result is strongest for
large, repeatedly queried columns, especially when ZoneMaps prune pages and multiple predicates
remain resident. `toIndices()` allocates and copies; prefer `countOnes()` or caller-owned
`positionsInto()` when possible. Sparse `gatherInto()` avoids per-value boundary calls, but dense
materialization still pays scalar extraction plus a Wasm-to-JS copy and may lose to typed arrays.

An exploratory `AdaptiveU32Column.sum()` took 5.55 ms versus 2.26 ms for an indexed `Uint32Array`
loop, so it was removed from both the public API and Wasm. `min` and `max` remain construction
metadata; range selection and `countOnes()` are the measured aggregate path. Do not add another
reduction merely for API symmetry.

The combined entrypoint trades bundle size for zero-copy cross-column composition. JavaScript for
unused exported classes can be tree-shaken, but functions inside its one Wasm module cannot. If an
application uses only signed i32 or u8, import `adaptive-simd-page-i32` or `bit-sliced-column`
instead. The u32 representation currently exists only here because sharing `SelectionMask` with
other column types is its intended composition path.

```sh
pnpm bench:columnar
pnpm bench:record:columnar
pnpm bench:compare:columnar
```

## Standalone build size

The isolated Vite production fixture using all three column types emits one 1.16 kB gzip Wasm asset
and a 7.17 kB gzip minified JavaScript wrapper. It does not emit any other jsimd Wasm module. The
snapshot envelope and validation code are included because the fixture exercises the full public
column contracts.

Benchmark source and the committed baseline are under
[`experiments/columnar`](../../experiments/columnar).

Files:

- `mod.ts`: shared allocator, public contracts, encoding selection, and ownership
- `kernels.wat`: signed/unsigned 32-bit page scans, bit-sliced u8 scans, and selection-mask kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated by `wasm-tools strip`, validated, and Git-ignored
