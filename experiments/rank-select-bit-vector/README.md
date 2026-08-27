# @mizchi/jsimd/rank-select-bit-vector experiment

Compares `RankSelectBitVector` with JavaScript functions using the same 512-bit cumulative index.
The benchmark includes the public call boundary and executes 1,024 pseudo-random queries per sample.

```ts
import { RankSelectBitVectorBuilder } from "@mizchi/jsimd/rank-select-bit-vector";

const builder = new RankSelectBitVectorBuilder(1_000_000);
builder.insert(1).insert(10).insert(999_999);
using bits = builder.freeze();
bits.rank1(11);
bits.select1(1);
bits.rank0(11);
bits.select0(1);
```

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Times are per batch of 1,024 queries:

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

All four `*Many` methods include temporary query copying and output reuse. Single queries are near
parity with indexed JavaScript; the useful SIMD interface is the bulk operation.

```sh
pnpm bench:rank-select-bit-vector
pnpm bench:record:rank-select-bit-vector
```

The committed baseline is environment-specific. The 512-bit rank index adds 0.78% logical storage
before allocator rounding.
