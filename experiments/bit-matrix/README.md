# BitMatrix experiment

Compares a 512×512 Boolean square, including transpose and result allocation, with an equivalent
scalar `Uint32Array` implementation. Construction of the input matrix is excluded.

Recorded with Vitest 4.1.11 / Node 24.12 / Apple M5:

| operation                     |     mean |
| :---------------------------- | -------: |
| `BitMatrix.multiply`          | 0.796 ms |
| scalar `Uint32Array` multiply | 5.224 ms |

The Wasm-resident implementation was 6.56x faster in this workload. The matrix occupies 32 KiB
before allocator size-class rounding. This benchmark does not compare a CSR or Roaring-row graph.

```sh
pnpm bench:bit-matrix
pnpm bench:record:bit-matrix
```
