# BlockedVectorArray

A frozen Wasm-resident `Float32` vector array for repeated exhaustive distance and similarity scans.

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
vectors.l1DistanceMany(new Float32Array([0, 0]), distances);
vectors.innerProductMany(new Float32Array([0, 0]), distances);

const ids = new Uint32Array(2);
const nearestDistances = new Float32Array(2);
vectors.topKInto(new Float32Array([0, 0]), ids, nearestDistances);
// ids: [0, 1], nearestDistances: [1, 1]
vectors.topKInnerProductInto(new Float32Array([0, 0]), ids, nearestDistances);

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

L1 and inner-product kernels traverse the same PDX64 layout and accumulate four rows per SIMD lane.
They use resident output blocks as accumulators to avoid another public layout. `topKInto` computes
exact squared distances into resident scratch, maintains a bounded max-heap in Wasm, and heap-sorts
the selected `(distance, row ID)` pairs before copying only `k` results back.

`topKInnerProductInto` reuses that selector: negated products enter the same ascending heap, then
the selected scores are restored, producing descending products. The caller chooses `k` through the
equal lengths of IDs and scores. Ties are ordered by row ID, so repeated calls are deterministic.

This is the PDX layout described in
[PDX: Product Distance eXecution](https://arxiv.org/html/2503.04422v1). That work evaluates blocks
of vectors in a dimension-major layout and reports 64 as its best tested native block size. This
module applies the base layout to exact squared L2, L1, and inner product in WebAssembly SIMD. It
does not implement the paper's pruning or quantized variants because no representative pruning
workload has yet met this project's admission policy. The authors' reference implementation is
[cwida/PDX](https://github.com/cwida/PDX).

## Performance and trade-offs

Vitest 4.1.11 / Node 24 / Apple M5, 16,384 vectors × 64 dimensions:

| operation                        | implementation             |      mean |
| :------------------------------- | :------------------------- | --------: |
| repeated exact squared-L2 scan   | `BlockedVectorArray` PDX64 | 0.0611 ms |
| repeated exact squared-L2 scan   | `PdxFloat32Index` PDX4     |  0.105 ms |
| repeated exact squared-L2 scan   | row-major JS scalar        |  0.562 ms |
| repeated exact L1 scan           | `BlockedVectorArray` PDX64 |  0.105 ms |
| repeated exact L1 scan           | row-major JS scalar        |  0.510 ms |
| repeated inner-product scan      | `BlockedVectorArray` PDX64 | 0.0990 ms |
| repeated inner-product scan      | row-major JS scalar        |  0.822 ms |
| fused top-k, `k=10`              | `topKInto`                 | 0.0621 ms |
| distance + bounded heap, `k=10`  | Wasm scan + JS heap        | 0.0887 ms |
| distance + full sort, `k=10`     | Wasm scan + JS sort        |  2.222 ms |
| fused top-k, `k=100`             | `topKInto`                 | 0.0681 ms |
| distance + bounded heap, `k=100` | Wasm scan + JS heap        |  0.101 ms |
| inner-product top-k, `k=10`      | fused Wasm selector        |  0.108 ms |
| inner-product top-k, `k=10`      | scan + bounded JS heap     |  0.134 ms |
| construct/copy                   | `BlockedVectorArray.from`  |  0.859 ms |
| construct/copy                   | `Float32Array.slice`       |  0.119 ms |

PDX64 was 1.72x faster than the existing four-vector PDX kernel and 9.21x faster than the scalar JS
scan. Fused top-k was 1.43x faster than the bounded JavaScript heap at `k=10`, 1.49x faster at
`k=100`, and 35.8x faster than full sorting. Construction was 7.24x slower than a row-major
typed-array copy. At this size, the extra construction cost is recovered after roughly two scans
versus scalar JS, but that break-even point depends on dimensions, engine, and hardware.

L1 was 4.84x faster and inner product 8.31x faster than their scalar loops. Fused inner-product
top-k was 1.24x faster than materializing every score and running the best bounded JS heap used by
the benchmark.

The repeated scan also won by 2.90x at 32 vectors × 64 dimensions, despite computing a complete
64-row padded block. Use this type when the same frozen vectors receive repeated exhaustive queries.
Prefer a plain `Float32Array` for one-shot work, frequent updates, or row-oriented access.
`residentBytes` includes padding to 64 rows per block, so collections just over a block boundary can
use nearly twice their logical `encodedBytes`. The `*Many` methods copy every logical result; prefer
the matching top-k method when only selected candidates are needed. Very large `k` reduces the
benefit of the bounded heap and should be measured for the target workload.

```sh
pnpm bench:blocked-vector-array
pnpm bench:record:blocked-vector-array
pnpm bench:compare:blocked-vector-array
```

The isolated Vite fixture emits one 2.28 kB Wasm asset (0.92 kB gzip) and a 7.61 kB minified JS
wrapper (2.87 kB gzip). It emits no other entrypoint's Wasm. `kernels.wat` is the source; generated
`kernels.wasm` is stripped, SIMD-validated, and Git-ignored.
