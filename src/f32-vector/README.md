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

Call `dispose()` or use `using` to return the backing block to the allocator.
`SimdFloat32Vector.allocatorStats()` exposes allocator state for leak/plateau tests.

Files:

- `mod.ts`: public API and ownership contract
- `kernels.wat`: SIMD dot-product and AXPY kernels
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated, stripped, and validated by `just build`; Git-ignored

Benchmarks and their baseline JSON live under `experiments/f32-vector`.
