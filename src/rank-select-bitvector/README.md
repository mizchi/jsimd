# RankSelectBitVector

An immutable, Wasm-resident bit vector with rank, select, and neighboring-bit queries. Build a
mutable bit pattern, freeze it, and release the frozen snapshot automatically with `using`:

```ts
import { RankSelectBitVectorBuilder } from "@mizchi/jsimd/rank-select-bitvector";

const builder = new RankSelectBitVectorBuilder(1_000_000);
builder.insert(1).insert(10).insert(999_999);

using bits = builder.freeze();
bits.get(10); // true
bits.rank1(11); // 2: ones in [0, 11)
bits.rank0(11); // 9
bits.select1(1); // 10: zero-based second one
bits.next1(11); // 999999
bits.prev1(11); // 10

const ends = new Uint32Array([0, 11, 1_000_000]);
const ranks = new Uint32Array(ends.length);
bits.rank1Many(ends, ranks); // reuses ranks and crosses the Wasm boundary once
```

For data that is already available as positions or packed words:

```ts
import { RankSelectBitVector } from "@mizchi/jsimd/rank-select-bitvector";

using positions = RankSelectBitVector.from(128, [1, 7, 64]);
using packed = RankSelectBitVector.fromUint32Array(64, new Uint32Array([0b1010, 0]));
```

`rank1(end)` and `rank0(end)` use half-open `[0, end)` semantics. `select1(rank)` is zero-based and
returns `-1` when that one does not exist. `next1` and `prev1` are inclusive and return `-1` when no
matching bit exists. The frozen snapshot is immutable; later builder changes do not affect it.

For query batches, prefer `rank1Many(ends, output)` and `select1Many(ranks, output)`. They copy one
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

|    length | single rank | JS rank | bulk rank | single select | JS select | bulk select |
| --------: | ----------: | ------: | --------: | ------------: | --------: | ----------: |
|    16,384 |     25.8 us | 24.0 us |   14.8 us |       33.0 us |   34.1 us |     19.9 us |
|   262,144 |     22.5 us | 21.7 us |   14.3 us |       39.1 us |   43.3 us |     25.2 us |
| 4,194,304 |     25.0 us | 22.7 us |   14.6 us |       46.6 us |   56.1 us |     18.7 us |

Bulk rank was at least 1.51x faster than indexed JavaScript in these cases. Bulk select was 1.71x
faster for 16K and 262K bits and 3.0x for 4M bits, although the largest scalar select sample had
higher variance. The single-query results are near parity and should not be presented as a SIMD win.

```sh
pnpm bench:rank-select-bitvector
pnpm bench:record:rank-select-bitvector
pnpm bench:compare:rank-select-bitvector
```

## Standalone build size

The isolated Vite fixture emits one 947 B Wasm asset (0.53 kB gzip) and a 7.37 kB JS wrapper (2.69
kB gzip). Bulk-query copying, builder code, allocator, and ownership checks are in the JS asset; no
other jsimd Wasm is emitted.

See [`experiments/rank-select-bitvector`](../../experiments/rank-select-bitvector/README.md) for the
recorded results.

Files:

- `mod.ts`: immutable API, builder, ownership, and index construction
- `kernels.wat`: SIMD index construction/rank plus select and neighbor queries
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 947-byte binary; stripped, validated, and Git-ignored
