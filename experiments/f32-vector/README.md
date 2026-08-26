# @mizchi/jsimd/f32-vector experiment

Experimental Wasm-resident Float32 vectors for fused bulk operations. It does not try to replace
ordinary JavaScript element access.

```ts
import { SimdFloat32Vector } from "@mizchi/jsimd/f32-vector";

using x = SimdFloat32Vector.from(new Float32Array([1, 2, 3, 4]));
using y = SimdFloat32Vector.from(new Float32Array([2, 4, 6, 8]));
x.dot(y); // 60
x.squaredDistance(y);
x.norm();
x.cosineSimilarity(y);
x.addScaled(y, 0.5);
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

The Node 24 / Apple M5 derived-reduction workload over 16,384 elements measured squared distance at
2.82 us versus 30.42 us scalar, norm at 2.66 us versus 33.51 us, and fused cosine similarity at 2.77
us versus 66.25 us. The scalar cosine baseline also computes dot and both norms in one pass.

The 16-element Node benchmark favored JavaScript slightly. The retained contract is repeated bulk
work over resident vectors, not tiny or copy-inclusive calls. One-to-many dot was left to
`BlockedVectorArray` rather than adding a second overlapping vector-array layout.

## Reproduce and compare

```sh
pnpm bench:f32-vector
pnpm bench:record:f32-vector
pnpm bench:compare:f32-vector
```

The committed baseline is environment-specific. Floating-point reduction order also differs from the
scalar JavaScript loop.

Leaving the `using` scope invokes the idempotent `Symbol.dispose` implementation. Allocation
statistics are available through `SimdFloat32Vector.allocatorStats()`; stress tests verify storage
reuse after 10,000 lifecycles.
