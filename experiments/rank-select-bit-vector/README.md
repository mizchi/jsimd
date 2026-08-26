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
```

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Times are per batch of 1,024 queries:

|    length | single rank | JS rank | bulk rank | single select | JS select | bulk select |
| --------: | ----------: | ------: | --------: | ------------: | --------: | ----------: |
|    16,384 |     25.8 us | 24.0 us |   14.8 us |       33.0 us |   34.1 us |     19.9 us |
|   262,144 |     22.5 us | 21.7 us |   14.3 us |       39.1 us |   43.3 us |     25.2 us |
| 4,194,304 |     25.0 us | 22.7 us |   14.6 us |       46.6 us |   56.1 us |     18.7 us |

`rank1Many` and `select1Many` include temporary query copying and output reuse. Single queries are
near parity with indexed JavaScript; the useful SIMD interface is the bulk operation.

```sh
pnpm bench:rank-select-bit-vector
pnpm bench:record:rank-select-bit-vector
pnpm bench:compare:rank-select-bit-vector
```

The committed baseline is environment-specific. The 512-bit rank index adds 0.78% logical storage
before allocator rounding.
