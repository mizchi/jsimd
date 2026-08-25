# @mizchi/jsimd/roaring-bitmap experiment

Compares `RoaringBitmap` intersection operations with sorted `Uint32Array` merge loops and native
`Set<number>` lookup loops. Dense data exercises SIMD bitmap containers; sparse data exercises many
sorted array containers.

```ts
import { RoaringBitmap } from "@mizchi/jsimd/roaring-bitmap";

using left = RoaringBitmap.from([1, 2, 65_536]);
using right = RoaringBitmap.from([2, 65_536, 70_000]);
using output = new RoaringBitmap();
left.andInto(right, output);
```

Recorded with Vitest 4.1.11 / Node 24 / Apple M5:

| workload                      | operation        |  Roaring | sorted `Uint32Array` | `Set<number>` |
| :---------------------------- | :--------------- | -------: | -------------------: | ------------: |
| 16 dense bitmap containers    | `andCardinality` |   6.3 us |              1.10 ms |       1.69 ms |
| 16 dense bitmap containers    | `andInto`        |  53.8 us |              1.22 ms |       2.37 ms |
| 1,024 sparse array containers | `andCardinality` |  30.9 us |             336.2 us |      154.4 us |
| 1,024 sparse array containers | `andInto`        | 111.9 us |             249.2 us |      741.9 us |

```sh
pnpm bench:roaring-uint32-set
pnpm bench:record:roaring-uint32-set
pnpm bench:compare:roaring-uint32-set
```

The committed baseline is environment-specific and excludes input construction. `andInto` reuses the
top-level output object and allocator free-list blocks.
