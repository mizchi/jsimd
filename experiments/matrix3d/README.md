# @mizchi/jsimd/matrix3d experiment

Compares resident SIMD batched multiplication with equivalent `Float32Array` and `Array<number>`
implementations. Setup copies and result allocation are excluded.

```ts
import { SimdMatrix3D } from "@mizchi/jsimd/matrix3d";

using left = SimdMatrix3D.from(2, 2, 2, [1, 2, 3, 4, 2, 0, 1, 2]);
using right = SimdMatrix3D.from(2, 2, 2, [5, 6, 7, 8, 1, 3, 4, 2]);
using output = new SimdMatrix3D(2, 2, 2);
left.batchMultiplyInto(right, output);
```

Recorded with Vitest 4.1.11 / Node 24 / Apple M5:

| shape `[B,M,K] × [B,K,N]` | resident SIMD | `Float32Array` | `Array<number>` |
| ------------------------: | ------------: | -------------: | --------------: |
|   `[1,16,16] × [1,16,16]` |       0.67 us |        3.37 us |         3.53 us |
| `[16,16,16] × [16,16,16]` |       8.93 us |        56.4 us |         56.9 us |
|     `[64,8,8] × [64,8,8]` |       5.27 us |        33.0 us |         35.8 us |
| `[16,32,32] × [16,32,32]` |       71.9 us |       406.3 us |        432.2 us |
|   `[8,64,64] × [8,64,64]` |       0.22 ms |        1.54 ms |         1.58 ms |

```sh
pnpm bench:matrix3d
pnpm bench:record:matrix3d
pnpm bench:compare:matrix3d
```

The committed baseline is environment-specific. It compares generic JavaScript loops, not optimized
BLAS, WebGPU, or specialized tensor libraries.
