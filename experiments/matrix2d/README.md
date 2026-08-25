# @mizchi/jsimd/matrix2d experiment

Compares resident row-major SIMD multiplication with equivalent `Float32Array` and `Array<number>`
implementations. Setup copies and result allocation are excluded.

```ts
import { SimdMatrix2D } from "@mizchi/jsimd/matrix2d";

using left = SimdMatrix2D.from(2, 2, [1, 2, 3, 4]);
using right = SimdMatrix2D.from(2, 2, [5, 6, 7, 8]);
using output = new SimdMatrix2D(2, 2);
left.multiplyInto(right, output);
```

At 64×64, SIMD took 32.9 us versus 314.0 us for `Float32Array` and 286.7 us for `Array<number>`. At
256×256, it took 1.83 ms versus 13.77 ms and 14.48 ms.

```sh
pnpm bench:matrix2d
pnpm bench:record:matrix2d
pnpm bench:compare:matrix2d
```

The committed baseline is environment-specific. It is a generic JavaScript-loop comparison, not a
claim against optimized BLAS, WebGPU, or specialized unrolled transform-matrix libraries.
