# BitSet and FixedBitSet

Dense integer sets backed by Wasm memory. Bulk operations use SIMD without copying the backing words
through JavaScript.

```ts
import { BitSet, FixedBitSet } from "@mizchi/jsimd/bitset";

using discovered = BitSet.from([1, 10, 999_999]);
discovered.insert(2_000_000); // grows automatically

using left = FixedBitSet.from(1_000_000, [1, 10, 999_999]);
using right = FixedBitSet.from(1_000_000, [10, 20]);

left.intersectionCount(right); // 1
left.unionWith(right);
```

Both types provide insertion/removal, membership, union, intersection, difference, symmetric
difference, cardinality, and intersection cardinality. `BitSet` grows on insertion and accepts
different backing capacities in set algebra. `FixedBitSet` rejects out-of-universe indices and
requires matching capacities, which catches accidental mixing of different ID universes.

Instances own allocator blocks. Declare them with `using` to return storage to the power-of-two free
list at scope exit. `BitSet.allocatorStats()` and `FixedBitSet.allocatorStats()` report the shared
allocator's live, free, reserved, and physical memory. Wasm linear memory does not shrink, but
released blocks are reused.

## Design source

The fixed-capacity contract and dense word-array operations are modeled after Rust's
[`fixedbitset`](https://docs.rs/fixedbitset/latest/fixedbitset/). jsimd keeps words in Wasm linear
memory and substitutes 128-bit logical operations and `i8x16.popcnt`; it is not wire-format
compatible with the Rust crate. `BitSet` uses the same representation and kernels, but reallocates
geometrically when an insertion exceeds its current capacity.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5 with a 4,194,304-bit universe. Input density was 1/7 and 1/11; the
Wasm and scalar typed-array implementations both reused resident mutable storage.

| operation          | Wasm SIMD | scalar `Uint32Array` | `Set<number>` |  BigInt |
| ------------------ | --------: | -------------------: | ------------: | ------: |
| intersection count |   38.9 us |             380.1 us |       11.2 ms |     n/a |
| in-place union     |   15.3 us |             302.6 us |           n/a | 48.2 us |

BigInt can win for small and medium immutable unions. `FixedBitSet` targets large mutable sets,
cardinality queries, and repeated compound operations. `BitSet` has the same steady-state bulk
performance after growth, but construction can copy its backing words several times. Prefer
`FixedBitSet` when the universe size is known; prefer `BitSet` when it is not. Neither is always
faster than JavaScript: point-heavy or small workloads should use `Set<number>` or BigInt.

```sh
pnpm bench:bitset
pnpm bench:record:bitset
pnpm bench:compare:bitset
```

## Standalone build size

The isolated Vite fixture importing both classes emits an 8.84 kB minified JS wrapper (2.80 kB gzip)
and one 0.50 kB Wasm asset (0.26 kB gzip). Both classes share that binary, so adding `BitSet` does
not add a second Wasm module.

Vitest baseline JSON and the complete benchmark source live in
[`experiments/bitset`](../../experiments/bitset).

Files:

- `mod.ts`: public API, ownership contract, and allocator integration
- `kernels.wat`: `v128` set operations and SIMD popcount
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
