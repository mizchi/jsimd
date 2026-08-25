# SIMD Int32Array

A fixed-length, Wasm-resident signed 32-bit array for repeated bulk operations. It is not intended
to make individual element access faster than JavaScript arrays.

```ts
import { SimdInt32Array } from "@mizchi/jsimd/i32-array";

using values = SimdInt32Array.from([5, -7, 11, 13, 2]);
using delta = SimdInt32Array.from([1, 1, 1, 1, 1]);

values.sum(); // 24
values.min(); // -7
values.max(); // 13
values.addAssign(delta);
```

`from` copies once into aligned Wasm memory. `sum`, `min`, `max`, `equals`, and `addAssign` then
cross the JavaScript/Wasm boundary once per complete operation. `sum` accumulates signed i32 lanes
into i64 lanes before converting the result to a JavaScript number.

The array owns allocator storage. Always use `using` so `Symbol.dispose` returns that storage to the
free list, including when the surrounding scope exits by throwing.

## Benchmark

Recorded with Vitest 4.1.11 / Node 24 / Apple M5. Timings exclude the one-time `from` copy and
compare equivalent hand-written loops. `Array<number>` addition uses `|0` to preserve signed i32
semantics.

|  elements | operation  | resident SIMD | `Int32Array` | `Array<number>` |
| --------: | ---------- | ------------: | -----------: | --------------: |
|     1,024 | sum        |       0.16 us |      0.55 us |         0.34 us |
|     1,024 | min        |       0.14 us |      0.53 us |         0.34 us |
|     1,024 | add-assign |       0.10 us |      0.63 us |         0.46 us |
|    16,384 | sum        |        2.0 us |       8.1 us |          5.5 us |
|    16,384 | min        |        2.0 us |       7.9 us |          5.5 us |
|    16,384 | add-assign |        1.3 us |       9.6 us |          7.6 us |
|   262,144 | sum        |       32.9 us |     128.2 us |         85.2 us |
|   262,144 | min        |       31.3 us |     131.2 us |         88.0 us |
|   262,144 | add-assign |       34.5 us |     209.4 us |        165.5 us |
| 4,194,304 | sum        |       0.61 ms |      2.58 ms |         1.80 ms |
| 4,194,304 | min        |       0.66 ms |      2.95 ms |         1.63 ms |
| 4,194,304 | add-assign |       0.53 ms |      2.80 ms |         2.62 ms |

The useful range starts around 1,024 elements in this environment. For one-off operations, include
the initial copy in your own benchmark before choosing a resident array.

```sh
pnpm bench:i32-array
pnpm bench:record:i32-array
pnpm bench:compare:i32-array
```

Files:

- `mod.ts`: public API and `using` ownership contract
- `kernels.wat`: SIMD reductions, equality, and in-place addition
- `kernels.d.wasm.ts`: typed Wasm module contract
- `kernels.wasm`: generated 767-byte binary; stripped, validated, and Git-ignored
