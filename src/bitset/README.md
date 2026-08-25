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

Instances own allocator blocks. Call `dispose()`, use `using`, or invoke `Symbol.dispose` to return
storage to the power-of-two free list. `FixedBitSet.allocatorStats()` reports live, free, reserved,
and physical memory. Wasm linear memory does not shrink, but released blocks are reused.

Files:

- `mod.ts`: public API, ownership contract, and allocator integration
- `kernels.wat`: `v128` set operations and SIMD popcount
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated and Git-ignored

Benchmarks and their baseline JSON live under `experiments/bitset`.
