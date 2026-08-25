# SIMD Float32Vector

A Wasm-resident Float32 vector for bulk numeric operations. It is designed for repeated operations
over resident data, rather than as a replacement for ordinary JavaScript element access.

```ts
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";

using x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
using y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));

x.dot(y); // 60
x.addScaled(y, 0.5); // x += 0.5 * y
```

`from` performs a one-time copy. `dot` and AXPY then cross the JavaScript/Wasm boundary once per
whole operation. SIMD reduction changes floating-point association and is not bit-identical to a
sequential JavaScript sum.

Declare vectors with `using` to return the backing block to the allocator at scope exit.
`SimdFloat32Vector.allocatorStats()` exposes allocator state for leak/plateau tests.

## Benchmark

Recorded on Deno 2.6.4 / Apple M5. SIMD timings exclude the one-time copy in `from` and model
repeated operations over resident vectors.

|  elements | resident SIMD dot | scalar `Float32Array` dot | resident SIMD AXPY | scalar AXPY |
| --------: | ----------------: | ------------------------: | -----------------: | ----------: |
|        16 |            6.1 ns |                   12.8 ns |             6.0 ns |     13.7 ns |
|     1,024 |           0.18 us |                   0.69 us |            0.11 us |     0.69 us |
|    16,384 |            2.6 us |                   17.5 us |             1.7 us |     11.3 us |
|   262,144 |           43.5 us |                  175.8 us |            28.6 us |    186.9 us |
| 4,194,304 |           0.86 ms |                    3.1 ms |            0.54 ms |      3.1 ms |

```sh
pnpm bench:f32-vector
pnpm bench:record:f32-vector
pnpm bench:compare:f32-vector
```

Vitest baseline JSON and the complete benchmark source live in
[`experiments/f32-vector`](../../experiments/f32-vector).

## Standalone build size

The isolated Vite fixture emits one 0.22 kB Wasm asset (0.17 kB gzip) and a 4.60 kB minified JS
wrapper (2.04 kB gzip). It emits no other jsimd Wasm module.

Files:

- `mod.ts`: public API and ownership contract
- `kernels.wat`: SIMD dot-product and AXPY kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
