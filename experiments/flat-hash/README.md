# @mizchi/jsimd/flat-hash experiment

Compares typed Wasm-resident flat hash tables with native `Set<number>`, `Map<number, number>`, and
sorted `Uint32Array` search. Bulk operations reuse caller-owned outputs and cross the JS/Wasm
boundary once.

```ts
import { FlatHashMapU32U32, FlatHashSetU32 } from "@mizchi/jsimd/flat-hash";

using set = FlatHashSetU32.from([1, 3, 5]);
const queries = new Uint32Array([0, 1, 5]);
const present = new Uint8Array(queries.length);
set.lookupMany(queries, present);

using map = FlatHashMapU32U32.from([[1, 100], [5, 500]]);
const values = new Uint32Array(queries.length);
map.lookupMany(queries, values, present);
```

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| operation                            | FlatHash | native / sorted reference |
| :----------------------------------- | -------: | ------------------------: |
| set lookup, 131,072 queries          | 728.4 us |                   4.86 ms |
| map lookup, 131,072 queries          | 846.2 us |                   4.97 ms |
| set clear + 262,144 inserts          |  1.66 ms |                  16.47 ms |
| map clear + 262,144 inserts          |  2.09 ms |                  19.42 ms |
| set point lookup, 1,024 calls        |  12.5 us |                    7.7 us |
| map point lookup, 1,024 calls        |  29.0 us |                    8.6 us |
| sorted-array lookup, 131,072 queries |        — |                  20.60 ms |

The dataset contains 262,144 unique mixed `u32` keys and a 50/50 hit/miss query stream. Construction
is excluded from lookup rows. Rebuild rows reuse existing table objects after `clear`; native
collections are also cleared and reused.

```sh
pnpm bench:flat-hash
pnpm bench:record:flat-hash
pnpm bench:compare:flat-hash
```

The baseline is environment-specific. It demonstrates why the public API includes both familiar
point operations and explicit batch operations: the point boundary favors native collections, while
SIMD group probing and one bulk boundary favor FlatHash.
