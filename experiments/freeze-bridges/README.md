# Explicit freeze bridges

These benchmarks measure the full copy and rebuild cost of the explicit mutable-to-frozen APIs. They
compare each bridge with direct construction from an already materialized `Uint32Array`.

The bridges are representation changes, not zero-copy casts:

- `Bitmap -> RankSelectBitVector` copies packed words and builds rank metadata;
- `FlatHashSetU32 -> StaticMphfU32` enumerates keys and searches a new static layout;
- `MonotoneUint32Builder` copies values before the selected ordered codec encodes them.

The mutable source remains owned by the caller, and later changes do not affect the frozen result.

Recorded with Vitest 4.1.11 / Node 24 / Apple M5:

| bridge                          | rows/keys | bridge mean | direct typed input mean |
| :------------------------------ | --------: | ----------: | ----------------------: |
| Bitmap -> RankSelectBitVector   |   262,144 |   0.0086 ms |               0.0075 ms |
| FlatHashSetU32 -> StaticMphfU32 |     4,096 |     12.1 ms |                 15.6 ms |
| Monotone builder -> EliasFano   |    65,536 |     2.50 ms |                 2.58 ms |
| Monotone builder -> PackedDelta |    65,536 |     1.56 ms |                 1.23 ms |

The MPHF result is not evidence that enumeration accelerates construction: input order and
hash-displacement search variance dominate at this size. These numbers characterize lifecycle cost,
not a performance advantage over direct construction.

```sh
pnpm bench:freeze-bridges
pnpm bench:record:freeze-bridges
pnpm bench:compare:freeze-bridges
```
