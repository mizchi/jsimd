# BlockedVectorArray

A frozen Wasm-resident `Float32` vector array for repeated exhaustive distance scans.

```ts
import { BlockedVectorArray } from "@mizchi/jsimd/blocked-vector-array";

// Row-major input: three vectors with two dimensions each.
using vectors = BlockedVectorArray.from(
  new Float32Array([0, 1, 1, 0, 2, 2]),
  3,
  2,
);

const distances = new Float32Array(vectors.length);
vectors.squaredDistanceMany(new Float32Array([0, 0]), distances);
// distances: [1, 1, 8]

const row = new Float32Array(vectors.dimensions);
vectors.rowInto(2, row); // [2, 2]
vectors.get(2, 1); // 2
```

The class owns Wasm linear memory. Bind it with `using`; `Symbol.dispose` returns its allocation to
the module-local reuse pool. `get` and `rowInto` are convenience methods, not the optimized
workload.

## Layout

Input is transposed into blocks of 64 vectors. Values within each block are dimension-major:

```text
dimension 0: row 0 ... row 63
dimension 1: row 0 ... row 63
...
```

The squared-L2 kernel broadcasts one query component, then updates 64 independent distances in 16
`f32x4` accumulators. It avoids a horizontal reduction per vector and reads each dimension as one
contiguous 256-byte run. The final block is zero-padded but only the logical `length` is copied back
to JavaScript.

This is the PDX layout described in
[PDX: Product Distance eXecution](https://arxiv.org/html/2503.04422v1). That work evaluates blocks
of vectors in a dimension-major layout and reports 64 as its best tested native block size. This
module applies the base layout to exact squared L2 in WebAssembly SIMD; it does not yet implement
the paper's pruning or quantized variants. The authors' reference implementation is
[cwida/PDX](https://github.com/cwida/PDX).

## Performance and trade-offs

Vitest 4.1.11 / Node 24 / Apple M5, 16,384 vectors × 64 dimensions:

| operation                      | implementation             |     mean |
| :----------------------------- | :------------------------- | -------: |
| repeated exact squared-L2 scan | `BlockedVectorArray` PDX64 | 0.061 ms |
| repeated exact squared-L2 scan | `PdxFloat32Index` PDX4     | 0.113 ms |
| repeated exact squared-L2 scan | row-major JS scalar        | 0.564 ms |
| construct/copy                 | `BlockedVectorArray.from`  | 0.924 ms |
| construct/copy                 | `PdxFloat32Index.from`     | 0.895 ms |
| construct/copy                 | `Float32Array.slice`       | 0.121 ms |

PDX64 was 1.84x faster than the existing four-vector PDX kernel and 9.21x faster than the scalar JS
scan. Construction was 7.67x slower than a row-major typed-array copy. At this size, the extra
construction cost is recovered after roughly two scans versus scalar JS, but that break-even point
depends on dimensions, engine, and hardware.

The repeated scan also won by 2.92x at 32 vectors × 64 dimensions, despite computing a complete
64-row padded block. Use this type when the same frozen vectors receive repeated exhaustive queries.
Prefer a plain `Float32Array` for one-shot work, frequent updates, or row-oriented access.
`residentBytes` includes padding to 64 rows per block, so collections just over a block boundary can
use nearly twice their logical `encodedBytes`. Every scan copies the query and logical result across
the JS/Wasm boundary; top-k selection is not yet fused.

```sh
pnpm bench:blocked-vector-array
pnpm bench:record:blocked-vector-array
pnpm bench:compare:blocked-vector-array
```

The isolated Vite fixture emits one 1.03 kB Wasm asset (0.43 kB gzip) and a 6.29 kB minified JS
wrapper (2.56 kB gzip). It emits no other entrypoint's Wasm. `kernels.wat` is the source; generated
`kernels.wasm` is stripped, SIMD-validated, and Git-ignored.
