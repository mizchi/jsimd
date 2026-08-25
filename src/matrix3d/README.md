# SIMD Matrix3D

A fixed-shape, batch-major Float32 tensor for batched matrix multiplication. Given left `[B, M, K]`
and right `[B, K, N]` tensors, `batchMultiply` produces `[B, M, N]`. Every matrix row is padded to
four elements, and the complete batch loop runs inside Wasm so the operation crosses the
JavaScript/Wasm boundary only once.

```ts
import { SimdMatrix3D } from "@mizchi/jsimd/matrix3d";

using left = SimdMatrix3D.from(2, 2, 2, [
  1,
  2,
  3,
  4,
  2,
  0,
  1,
  2,
]);
using right = SimdMatrix3D.from(2, 2, 2, [
  5,
  6,
  7,
  8,
  1,
  3,
  4,
  2,
]);
using output = left.batchMultiply(right);

output.toFloat32Array(); // [19, 22, 43, 50, 2, 6, 9, 7]
```

For allocation-free repeated multiplication, preallocate the output:

```ts
using output = new SimdMatrix3D(left.batches, left.rows, right.columns);
left.batchMultiplyInto(right, output);
```

The two inputs must have the same batch count; broadcasting is intentionally not implemented. The
output must not alias either input. `addAssign`, `scaleAssign`, `fill`, `get`, and `set` are also
available. Individual element access is not expected to beat ordinary JavaScript arrays.

The tensor owns Wasm allocator storage. Always use `using` so scope exit returns it through
`Symbol.dispose`, including exceptional exits.

## Batched multiplication benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Inputs and output are resident and preallocated;
the benchmark excludes `from` and output allocation. References use the same batch-major `b-i-k-j`
algorithm over `Float32Array` and `Array<number>`.

| shape `[B,M,K] × [B,K,N]` | resident SIMD | `Float32Array` | `Array<number>` | SIMD speedup |
| ------------------------: | ------------: | -------------: | --------------: | -----------: |
|   `[1,16,16] × [1,16,16]` |       0.67 us |        3.37 us |         3.53 us |   5.05–5.29x |
| `[16,16,16] × [16,16,16]` |       8.93 us |        56.4 us |         56.9 us |   6.32–6.38x |
|     `[64,8,8] × [64,8,8]` |       5.27 us |        33.0 us |         35.8 us |   6.26–6.79x |
| `[16,32,32] × [16,32,32]` |       71.9 us |       406.3 us |        432.2 us |   5.65–6.01x |
|   `[8,64,64] × [8,64,64]` |       0.22 ms |        1.54 ms |         1.58 ms |   7.06–7.26x |

Run or update the checked-in Vitest benchmark with:

```sh
pnpm bench:matrix3d
pnpm bench:record:matrix3d
pnpm bench:compare:matrix3d
```

These are generic JavaScript-loop comparisons, not claims against optimized BLAS or WebGPU. See
[`experiments/matrix3d`](../../experiments/matrix3d/README.md) for the committed raw baseline.

Files:

- `mod.ts`: shape, indexing, ownership, and high-level operations
- `kernels.wat`: row-padded elementwise and batched multiplication kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 455-byte binary; stripped, validated, and Git-ignored
