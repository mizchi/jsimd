# FixedBitSet

A fixed-capacity integer set backed by Wasm memory. Bulk operations use SIMD without copying the
backing words through JavaScript.

```ts
import { FixedBitSet } from "@mizchi/jsimd/bitset";

using left = FixedBitSet.from(1_000_000, [1, 10, 999_999]);
using right = FixedBitSet.from(1_000_000, [10, 20]);

left.intersectionCount(right); // 1
left.unionWith(right);
```

Available operations include insertion/removal, membership, union, intersection, difference,
symmetric difference, cardinality, and intersection cardinality.

Instances own allocator blocks. Declare them with `using` to return storage to the power-of-two free
list at scope exit. `FixedBitSet.allocatorStats()` reports live, free, reserved, and physical
memory. Wasm linear memory does not shrink, but released blocks are reused.

## Design source

The fixed-capacity contract and dense word-array operations are modeled after Rust's
[`fixedbitset`](https://docs.rs/fixedbitset/latest/fixedbitset/). jsimd keeps words in Wasm linear
memory and substitutes 128-bit logical operations and `i8x16.popcnt`; it is not wire-format
compatible with the Rust crate.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5 with a 4,194,304-bit universe. Input density was 1/7 and 1/11; the
Wasm and scalar typed-array implementations both reused resident mutable storage.

| operation          | Wasm SIMD | scalar `Uint32Array` | `Set<number>` |  BigInt |
| ------------------ | --------: | -------------------: | ------------: | ------: |
| intersection count |   38.9 us |             380.1 us |       11.2 ms |     n/a |
| in-place union     |   15.3 us |             302.6 us |           n/a | 48.2 us |

BigInt can win for small and medium immutable unions. `FixedBitSet` targets large mutable sets,
cardinality queries, and repeated compound operations.

```sh
pnpm bench:bitset
pnpm bench:record:bitset
pnpm bench:compare:bitset
```

## Standalone build size

The isolated Vite fixture emits one 0.50 kB Wasm asset (0.26 kB gzip) and a 5.63 kB JS wrapper (2.33
kB gzip). Importing only `@mizchi/jsimd/bitset` emits exactly that one Wasm file.

Vitest baseline JSON and the complete benchmark source live in
[`experiments/bitset`](../../experiments/bitset).

Files:

- `mod.ts`: public API, ownership contract, and allocator integration
- `kernels.wat`: `v128` set operations and SIMD popcount
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
