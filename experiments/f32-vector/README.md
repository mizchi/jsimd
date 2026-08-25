# @mizchi/jsimd/f32-vector experiment

Experimental Wasm-resident Float32 vectors for fused bulk operations. It does not try to replace
ordinary JavaScript element access.

```ts
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";

const x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
const y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));
x.dot(y); // 60
x.addScaled(y, 0.5);
x.dispose();
y.dispose();
```

## Recorded result

Deno 2.6.4, Apple M5:

|  elements | resident SIMD dot | scalar `Float32Array` dot | resident SIMD AXPY | scalar AXPY |
| --------: | ----------------: | ------------------------: | -----------------: | ----------: |
|        16 |            6.1 ns |                   12.8 ns |             6.0 ns |     13.7 ns |
|     1,024 |           0.18 us |                   0.69 us |            0.11 us |     0.69 us |
|    16,384 |            2.6 us |                   17.5 us |             1.7 us |     11.3 us |
|   262,144 |           43.5 us |                  175.8 us |            28.6 us |    186.9 us |
| 4,194,304 |           0.86 ms |                    3.1 ms |            0.54 ms |      3.1 ms |

These timings exclude the one-time copy performed by `from`. They model repeated operations over
resident vectors.

## Reproduce and compare

```sh
pnpm bench:f32-vector
pnpm bench:record:f32-vector
pnpm bench:compare:f32-vector
```

The committed baseline is environment-specific. Floating-point reduction order also differs from the
scalar JavaScript loop.

`dispose()` is explicit and idempotent. Allocation statistics are available through
`SimdFloat32Vector.allocatorStats()`; stress tests verify storage reuse after 10,000 lifecycles.
