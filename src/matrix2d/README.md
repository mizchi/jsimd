# SIMD Matrix2D

A fixed-shape, row-major Float32 matrix for repeated CPU-side bulk operations. Every row is padded
to four elements so matrix multiplication can use contiguous `f32x4` loads and stores.

```ts
import { SimdMatrix2D } from "@mizchi/jsimd/matrix2d";

using left = SimdMatrix2D.from(2, 3, [1, 2, 3, 4, 5, 6]);
using right = SimdMatrix2D.from(3, 2, [7, 8, 9, 10, 11, 12]);
using output = left.multiply(right);

output.toFloat32Array(); // [58, 64, 139, 154]
```

For allocation-free repeated multiplication, preallocate the output and call `multiplyInto`:

```ts
using output = new SimdMatrix2D(left.rows, right.columns);
left.multiplyInto(right, output);
```

The output must not alias either input. `addAssign`, `scaleAssign`, `fill`, `get`, and `set` are
also available. Individual element access is not expected to beat ordinary JavaScript arrays.

The matrix owns Wasm allocator storage. Always use `using` so scope exit returns it through
`Symbol.dispose`, including exceptional exits.

## Matrix multiplication benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Inputs and output are resident and preallocated;
the benchmark excludes `from` and output allocation. References use the same row-major `i-k-j`
algorithm over `Float32Array` and `Array<number>`.

| square size | resident SIMD | `Float32Array` | `Array<number>` |
| ----------: | ------------: | -------------: | --------------: |
|           4 |       0.12 us |        0.13 us |         0.17 us |
|          16 |       0.80 us |         3.7 us |          3.9 us |
|          32 |        5.5 us |        36.4 us |         37.7 us |
|          64 |       32.9 us |       314.0 us |        286.7 us |
|         128 |       0.24 ms |        1.76 ms |         1.75 ms |
|         256 |       1.83 ms |       13.77 ms |        14.48 ms |

The 4×4 result does not imply a win over specialized unrolled graphics libraries. This package
targets dynamic matrices and repeated operations from roughly 16×16 upward. It also does not replace
GPU or native BLAS workloads.

```sh
pnpm bench:matrix2d
pnpm bench:record:matrix2d
pnpm bench:compare:matrix2d
```

Files:

- `mod.ts`: shape, indexing, ownership, and high-level operations
- `kernels.wat`: row-padded elementwise and matrix multiplication kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 372-byte binary; stripped, validated, and Git-ignored
