# @mizchi/jsimd/bit-sliced-column experiment

Compares repeated predicates over a five-bit `BitSlicedColumnU8` with specialized scalar
`Uint8Array` loops. Both implementations emit a packed bitmap and compute its cardinality.

```ts
import { BitSlicedColumnU8, BitSliceMask } from "@mizchi/jsimd/bit-sliced-column";

using column = BitSlicedColumnU8.from(new Uint8Array([1, 4, 7, 10]), 4);
using output = new BitSliceMask(column.length);
column.between(4, 10, output);
```

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5 over 4,194,304 rows:

| operation                 | Bit-sliced SIMD | scalar `Uint8Array` | speedup |
| :------------------------ | --------------: | ------------------: | ------: |
| equality                  |        106.6 us |             2.41 ms |   22.6x |
| less-than                 |        137.0 us |             4.05 ms |   29.6x |
| inclusive between         |        239.1 us |             4.69 ms |   19.6x |
| two predicates + mask AND |        281.2 us |             4.95 ms |   17.6x |

The scalar references are dedicated loops rather than callback-based generic scanners. Construction
and row-ID materialization are excluded; result-mask creation and popcount are included. This is a
large static-scan workload, not evidence that point access or short columns beat native arrays.

```sh
pnpm bench:bit-sliced-column
pnpm bench:record:bit-sliced-column
pnpm bench:compare:bit-sliced-column
```
