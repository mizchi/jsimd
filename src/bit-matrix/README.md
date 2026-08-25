# BitMatrix

A dense Boolean matrix stored row-major in Wasm linear memory. Rows are padded to 128-bit
boundaries, and Boolean-semiring multiplication tests four 32-bit words at a time with `v128.and`
and `v128.any_true`.

```ts
import { BitMatrix } from "@mizchi/jsimd/bit-matrix";

using graph = BitMatrix.fromEdges(3, 3, [[0, 1], [1, 2]]);
graph.row(0).toArray(); // [1]

using twoSteps = graph.multiply(graph);
twoSteps.row(0).toArray(); // [2]

using reversed = graph.transpose();
reversed.has(2, 1); // true
```

`row()` returns a non-owning view and allocates no Wasm storage. The view becomes invalid when its
parent matrix leaves its `using` scope. `transpose()` and `multiply()` return owning matrices and
must also be declared with `using`.

The representation uses approximately `rows * ceil(columns / 128) * 16` bytes. It is appropriate for
small and medium dense relation matrices, dependency analysis, permission tables, automata, and
batched reachability primitives. It is not appropriate for large sparse graphs: a 100,000 square
matrix would require multiple gigabytes regardless of its edge count. Roaring rows or CSR should be
used for that workload; this entrypoint intentionally does not switch representations implicitly.

## Design source

Boolean multiplication uses OR as addition and AND as multiplication. The graph-as-matrix model and
the need to select dense or sparse physical layouts separately follow the semiring formulation in
[SlimSell](https://arxiv.org/abs/2010.09913). This implementation is a compact dense Wasm-SIMD
kernel, not a port of SlimSell's sparse SELL-C-sigma layout.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5. The workload squares a 512×512 matrix with
about eight set columns per row. Both measurements include transpose and result allocation but
exclude input construction.

| operation                     |     mean | relative     |
| :---------------------------- | -------: | :----------- |
| `BitMatrix.multiply`          | 0.796 ms | 6.56x faster |
| scalar `Uint32Array` multiply | 5.224 ms | reference    |

The comparison is against a direct dense typed-array implementation, not a tuned sparse graph
library. Small matrices can lose to JavaScript because allocation and the Wasm boundary dominate;
large sparse matrices lose on memory before kernel speed matters.

```sh
pnpm bench:bit-matrix
pnpm bench:record:bit-matrix
pnpm bench:compare:bit-matrix
```

## Standalone build size

The isolated Vite fixture emits a 5.99 kB minified JavaScript wrapper (2.53 kB gzip) and one 0.51 kB
Wasm asset (0.36 kB gzip). Importing this subpath emits no BitSet, Roaring, or matrix-float Wasm.

See [`experiments/bit-matrix`](../../experiments/bit-matrix/README.md) for the benchmark source and
committed baseline.

Files:

- `mod.ts`: shape contract, mutation, row views, ownership, transpose, and multiplication
- `kernels.wat`: row popcount, transpose, and SIMD Boolean multiplication
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated stripped and validated binary; Git-ignored
