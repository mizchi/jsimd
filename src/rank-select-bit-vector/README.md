# RankSelectBitVector

An immutable, Wasm-resident bit vector with rank, select, and neighboring-bit queries. Build a
mutable bit pattern, freeze it, and release the frozen snapshot automatically with `using`:

This type always stores rank/select metadata; it is not the package's generic packed-bit sequence.
The `BitVector` name and `bit-vector` subpath are reserved for a future unindexed immutable sequence
and are not currently exported. Use `Bitmap` or `DenseBitmap` for mutable set algebra.

```ts
import { RankSelectBitVectorBuilder } from "@mizchi/jsimd/rank-select-bit-vector";

const builder = new RankSelectBitVectorBuilder(1_000_000);
builder.insert(1).insert(10).insert(999_999);

using bits = builder.freeze();
bits.get(10); // true
bits.rank1(11); // 2: ones in [0, 11)
bits.rank0(11); // 9
bits.select1(1); // 10: zero-based second one
bits.select0(0); // 0: zero-based first zero
bits.next1(11); // 999999
bits.prev1(11); // 10
bits.next0(2); // 2
bits.prev0(9); // 9

const ends = new Uint32Array([0, 11, 1_000_000]);
const ranks = new Uint32Array(ends.length);
bits.rank1Many(ends, ranks); // reuses ranks and crosses the Wasm boundary once
bits.rank0Many(ends, ranks);

const zeroRanks = new Uint32Array([0, 1, 2]);
const zeroPositions = new Int32Array(zeroRanks.length);
bits.select0Many(zeroRanks, zeroPositions);
```

For data that is already available as positions or packed words:

```ts
import { RankSelectBitVector } from "@mizchi/jsimd/rank-select-bit-vector";

using positions = RankSelectBitVector.from(128, [1, 7, 64]);
using packed = RankSelectBitVector.fromUint32Array(64, new Uint32Array([0b1010, 0]));
```

To freeze an existing mutable bitmap, import both explicit entrypoints:

```ts
import { Bitmap } from "@mizchi/jsimd/bitmap";
import { RankSelectBitVector } from "@mizchi/jsimd/rank-select-bit-vector";

using mutable = Bitmap.from([1, 31, 32, 100]);
using frozen = RankSelectBitVector.fromBitmap(mutable);
```

This is a snapshot, not shared ownership or a zero-copy view. It copies every packed word across the
two independent Wasm memories and builds a new 512-bit rank index. Later bitmap changes are not
visible in `frozen`. For 262,144 bits, the recorded full bridge took 0.0086 ms versus 0.0075 ms when
packed words were already materialized; the ratio is engine-sensitive at this scale.

`rank1(end)` and `rank0(end)` use half-open `[0, end)` semantics. `select1(rank)` and
`select0(rank)` are zero-based and return `-1` when the requested bit does not exist.
`next1`/`prev1` and `next0`/`prev0` are inclusive and return `-1` when no matching bit exists.
Zero-bit queries mask the last logical word, so allocation and SIMD padding beyond `length` is never
observable. The frozen snapshot is immutable; later builder changes do not affect it.

For query batches, prefer `rank1Many`/`rank0Many` and `select1Many`/`select0Many`. They copy one
packed query array into temporary Wasm storage, execute the complete batch in one call, copy into
the reusable output, and return all temporary storage before the call completes. Single-query
methods remain useful for control-flow-heavy code but do not consistently beat an indexed JavaScript
implementation.

The structure stores a cumulative count for every 512 data bits. That is one 32-bit counter per 64
bytes, or 0.78% logical index overhead, before allocator size-class rounding. A rank query loads at
most four 128-bit blocks after its indexed prefix. `select1` binary-searches the cumulative index,
then scans at most sixteen 32-bit words.

## Design sources

Rank/select over a packed bitvector is the standard succinct-index foundation. The 512-bit
superblock and 128-bit scan layout is a Wasm-oriented simplification informed by
[“Theory Meets Practice for Bit Vectors Supporting Rank and Select”](https://arxiv.org/html/2509.17819v1),
rather than a reproduction of its wider native-SIMD implementation. The public half-open `rank` and
zero-based `select` semantics are documented above because conventions differ across libraries.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. The benchmark compares each public Wasm call with
a JavaScript implementation using the same 512-bit index. Each sample executes 1,024 pseudo-random
queries and includes JS/Wasm call overhead. Bulk timings include query copying and output reuse.

|    length | single rank1 | JS rank1 | bulk rank1 | single select1 | JS select1 | bulk select1 |
| --------: | -----------: | -------: | ---------: | -------------: | ---------: | -----------: |
|    16,384 |      12.2 us |  10.6 us |     7.0 us |        17.1 us |    16.2 us |       9.1 us |
|   262,144 |      11.5 us |  10.8 us |     7.2 us |        20.2 us |    23.0 us |      13.2 us |
| 4,194,304 |      11.9 us |  11.0 us |     6.9 us |        20.6 us |    24.9 us |      17.1 us |

|    length | JS rank0 | bulk rank0 | JS select0 | bulk select0 |
| --------: | -------: | ---------: | ---------: | -----------: |
|    16,384 |  10.7 us |     7.8 us |    29.5 us |      15.2 us |
|   262,144 |  10.9 us |     7.2 us |    36.6 us |      20.1 us |
| 4,194,304 |  10.7 us |     7.4 us |    42.0 us |      24.0 us |

Bulk zero rank was 1.37–1.51x faster than indexed JavaScript, and bulk zero select was 1.75–1.94x
faster. One-bit bulk operations also win, while the single-query results remain near parity and
should not be presented as a SIMD win.

```sh
pnpm bench:rank-select-bit-vector
pnpm bench:record:rank-select-bit-vector
pnpm bench:compare:rank-select-bit-vector
```

## Standalone build size

The isolated Vite fixture emits one 1.58 kB Wasm asset (0.77 kB gzip) and a 9.84 kB minified JS
wrapper (2.97 kB gzip). Bulk-query copying, builder code, allocator, and ownership checks are in the
JS asset; no other jsimd Wasm is emitted.

See [`experiments/rank-select-bit-vector`](../../experiments/rank-select-bit-vector/README.md) for
the recorded results.

Files:

- `mod.ts`: immutable API, builder, ownership, and index construction
- `kernels.wat`: SIMD index construction/rank plus one- and zero-bit select/neighbor queries
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated binary; stripped, validated, and Git-ignored
