# SIMD Float32Vector

A Wasm-resident Float32 vector for bulk numeric operations. It is designed for repeated operations
over resident data, rather than as a replacement for ordinary JavaScript element access.

```ts
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";

using x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
using y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));

x.dot(y); // 60
x.squaredDistance(y); // 30
x.norm(); // sqrt(30)
x.cosineSimilarity(y); // 1
x.addScaled(y, 0.5); // x += 0.5 * y
```

`from` performs a one-time copy. Every reduction and AXPY then crosses the JavaScript/Wasm boundary
once per whole operation. `cosineSimilarity` accumulates dot product and both squared norms in one
fused pass. It returns `NaN` when either vector has zero norm.

SIMD reduction changes floating-point association and is not bit-identical to a sequential
JavaScript sum. All binary operations require equal logical lengths.

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

For 16,384 resident elements on Node 24 / Apple M5, the added reductions measured:

| operation         | resident SIMD | scalar `Float32Array` | result       |
| :---------------- | ------------: | --------------------: | :----------- |
| squared distance  |       2.82 us |              30.42 us | 10.8x faster |
| norm              |       2.66 us |              33.51 us | 12.6x faster |
| cosine similarity |       2.77 us |              66.25 us | 23.9x faster |

The scalar cosine baseline is already fused into one pass. These are resident-data measurements;
construction is excluded. At 16 elements, the recorded dot and AXPY benchmark was slightly faster in
JavaScript, so use typed arrays for tiny or one-shot work.

A one-to-many `dotMany` API is intentionally not added here. That workload needs a matrix-like
layout and is served by `BlockedVectorArray`; duplicating it on a single-vector abstraction would
create overlapping performance contracts.

## Standalone build size

The isolated Vite fixture emits one 0.50 kB Wasm asset (0.31 kB gzip) and a 4.90 kB minified JS
wrapper (2.12 kB gzip). It emits no other jsimd Wasm module.

Files:

- `mod.ts`: public API and ownership contract
- `kernels.wat`: SIMD dot, distance, norm, cosine, and AXPY kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored
