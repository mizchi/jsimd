# @mizchi/jsimd/i32-array experiment

Compares the Wasm-resident `SimdInt32Array` with hand-written `Int32Array` and `Array<number>`
loops. The setup copy is excluded to model repeated operations over fixed data.

```ts
import { SimdInt32Array } from "@mizchi/jsimd/i32-array";

using values = SimdInt32Array.from([1, 2, 3, 4]);
values.sum();
```

At 262,144 elements, SIMD sum and min took about 31–33 us versus 85–88 us for `Array<number>` and
128–131 us for `Int32Array`. In-place addition took 34.5 us versus 165.5 us and 209.4 us,
respectively. See the package README for the complete table.

```sh
pnpm bench:i32-array
pnpm bench:record:i32-array
pnpm bench:compare:i32-array
```

The committed baseline is environment-specific. Compare results only on the same designated machine
and runtime.
