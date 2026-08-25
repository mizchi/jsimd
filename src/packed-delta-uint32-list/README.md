# PackedDeltaUint32List

An immutable, Wasm-resident compressed list for strictly increasing unsigned 32-bit integers. It
uses separate Stream VByte control/data streams, decodes four deltas with `i8x16.swizzle`, and adds
an absolute checkpoint every 128 values.

```ts
import {
  PackedDeltaUint32List,
  PackedDeltaUint32ListBuilder,
} from "@mizchi/jsimd/packed-delta-uint32-list";

const builder = new PackedDeltaUint32ListBuilder();
builder.append(3).append(9).append(100).append(1_000);
using postings = builder.freeze();

postings.at(2); // 100
postings.lowerBound(10); // 2
postings.nextGEQ(10); // 100

const decoded = new Uint32Array(3);
postings.decodeInto(1, decoded); // writes [9, 100, 1000], returns 3

using selected = PackedDeltaUint32List.from([9, 20, 1_000]);
const intersection = new Uint32Array(3);
const count = postings.intersectInto(selected, intersection); // 2
intersection.subarray(0, count); // [9, 1000]
```

Input must already be strictly increasing. Duplicate or descending values throw instead of being
silently normalized. `decodeInto` and `intersectInto` write at most the output capacity and return
the number written. Declare every owning list with `using`; scope exit returns its Wasm allocations
through `Symbol.dispose`.

The representation is intended for frozen postings, offsets, timestamps, and adjacency lists. It is
not a faster replacement for an uncompressed `Uint32Array` in every operation: native copying and
binary search remain substantially faster. Its useful current trade-off is compact resident storage
plus a bulk intersection kernel that avoids full materialization.

## Design source

The separated control/data stream and shuffle-table decoder follow the Stream VByte family described
in [“Techniques for Inverted Index Compression”](https://arxiv.org/html/1908.10598v2). jsimd adds
128-value absolute checkpoints and a Wasm-v128 four-value intersection kernel. It does not implement
every codec or block-selection strategy evaluated by that survey.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5, excluding construction. Both 262,144-value
datasets use one-byte deltas, so the Stream VByte stream plus checkpoints occupies 1.31 bytes/value,
about 33% of the 4-byte `Uint32Array` payload.

| workload / operation                  | PackedDelta | `Uint32Array` | relative result          |
| :------------------------------------ | ----------: | ------------: | :----------------------- |
| small deltas / full decode or copy    |    371.9 us |       23.7 us | TypedArray 15.7x faster  |
| variable deltas / full decode or copy |    399.1 us |       23.3 us | TypedArray 17.1x faster  |
| small deltas / 1,024 lower bounds     |    162.3 us |       55.9 us | TypedArray 2.9x faster   |
| variable deltas / 1,024 lower bounds  |    151.6 us |       45.4 us | TypedArray 3.3x faster   |
| two postings / reusable intersection  |    957.6 us |       1.34 ms | PackedDelta 1.40x faster |

Intersection is the promising bulk path, but the result varies with engine and data distribution.
Rerun the benchmark on the target runtime. Elias–Fano, FOR+BP128, and Roaring comparisons remain
follow-up decision gates rather than settled claims.

```sh
pnpm bench:packed-delta-uint32-list
pnpm bench:record:packed-delta-uint32-list
pnpm bench:compare:packed-delta-uint32-list
```

## Standalone build size

The isolated Vite fixture emits one 1.49 kB Wasm asset (0.88 kB gzip) and a 6.96 kB JS wrapper (2.76
kB gzip). Importing this subpath does not emit Roaring, FlatHash, or byte-scanner Wasm.

See [`experiments/packed-delta-uint32-list`](../../experiments/packed-delta-uint32-list/README.md)
for the benchmark source and committed baseline.

Files:

- `mod.ts`: builder, encoding, public queries, and ownership
- `kernels.wat`: shuffle-table decode, checkpoint queries, and SIMD group intersection
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 1,500-byte binary; stripped, validated, and Git-ignored
