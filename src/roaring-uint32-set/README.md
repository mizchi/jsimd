# RoaringUint32Set

A mutable, Wasm-resident Roaring-style set for unsigned 32-bit integers. The high 16 bits select a
container. The low 16 bits use a sorted `Uint16` array through 4,096 values and an 8 KiB bitmap from
4,097 values onward.

```ts
import { RoaringUint32Set } from "@mizchi/jsimd/roaring-uint32-set";

using active = RoaringUint32Set.from([1, 10, 65_536, 0xffff_ffff]);
using selected = RoaringUint32Set.from([10, 65_536, 70_000]);

active.has(0xffff_ffff); // true
active.andCardinality(selected); // 2, without creating an intersection
active.intersects(selected); // true, stops at the first matching value
active.jaccard(selected); // 2 / 5

using intersection = new RoaringUint32Set();
active.andInto(selected, intersection);
intersection.toUint32Array(); // [10, 65536]
```

Mutation and inclusive range iteration are also available:

```ts
active.insert(11).insert(12).remove(1);
active.forEachRange((start, end) => {
  console.log(start, end);
});
```

The output of `andInto` must not alias either input. Every owning set should be declared with
`using`; scope exit returns all of its array and bitmap container allocations via `Symbol.dispose`.

This first version implements the canonical array and bitmap containers and dynamically converts at
the 4,096/4,097 boundary. Run containers and portable Roaring serialization are not implemented yet,
so this is not currently a drop-in wire-format replacement for CRoaring or RoaringBitmap libraries.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. The experiment compares non-materializing
cardinality and reusable-output intersection with sorted `Uint32Array` and `Set<number>` references.
Construction is excluded.

| workload                      | operation        |  Roaring | sorted `Uint32Array` | `Set<number>` |
| :---------------------------- | :--------------- | -------: | -------------------: | ------------: |
| 16 dense bitmap containers    | `andCardinality` |   6.3 us |              1.10 ms |       1.69 ms |
| 16 dense bitmap containers    | `andInto`        |  53.8 us |              1.22 ms |       2.37 ms |
| 1,024 sparse array containers | `andCardinality` |  30.9 us |             336.2 us |      154.4 us |
| 1,024 sparse array containers | `andInto`        | 111.9 us |             249.2 us |      741.9 us |

Dense cardinality is the strongest SIMD case: it scans compact 8 KiB containers with `v128.and` and
`i8x16.popcnt`, without materializing the result. Sparse containers use scalar sorted-u16 merge
inside Wasm; they still benefit from compact data and per-container processing. Benchmark variance
depends on the runtime, so rerun on the target engine before choosing a representation.

```sh
pnpm bench:roaring-uint32-set
pnpm bench:record:roaring-uint32-set
pnpm bench:compare:roaring-uint32-set
```

See [`experiments/roaring-uint32-set`](../../experiments/roaring-uint32-set/README.md) for recorded
results.

Files:

- `mod.ts`: public API, high-key metadata, container conversion, and ownership
- `kernels.wat`: SIMD bitmap intersections and array/bitmap container kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 1,026-byte binary; stripped, validated, and Git-ignored
