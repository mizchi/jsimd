# @mizchi/jsimd/roaring-bitmap experiment

Compares `RoaringBitmap` construction, complete set algebra, cardinality, and batched membership
with sorted `Uint32Array` merge loops and native `Set<number>` lookup loops. Dense data exercises
SIMD bitmap containers; sparse data exercises many sorted array containers.

```ts
import { RoaringBitmap } from "@mizchi/jsimd/roaring-bitmap";

using left = RoaringBitmap.from([1, 2, 65_536]);
using right = RoaringBitmap.from([2, 65_536, 70_000]);
using output = new RoaringBitmap();
left.andInto(right, output);
left.orInto(right, output);
left.xorInto(right, output);
left.andNotInto(right, output);
```

Recorded with Vitest 4.1.11 / Node 24 / Apple M5:

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

```sh
pnpm bench:roaring-bitmap
pnpm bench:record:roaring-bitmap
pnpm bench:compare:roaring-bitmap
```

The committed baseline is environment-specific. Resident `*Into` operations reuse the top-level
output object and allocator free-list blocks; construction is reported separately.
