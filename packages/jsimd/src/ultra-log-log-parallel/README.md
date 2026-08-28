# ParallelUltraLogLogU32

Persistent-Worker execution for [`UltraLogLogU32`](../ultra-log-log/README.md). This is a separate
subpath so importing the synchronous sketch never emits Worker code.

```ts
import { ParallelUltraLogLogU32 } from "@mizchi/jsimd/ultra-log-log-parallel";

await using sketch = await ParallelUltraLogLogU32.create({
  maxValues: 1_048_576,
  precision: 14,
  workerCount: 8,
});

await sketch.replace(values);
console.log(sketch.estimate());
```

The default planner uses the serial sketch below 65,536 values and Workers for larger replacement
batches. Override `workerThreshold` after benchmarking the target runtime. Browser use requires
`SharedArrayBuffer`, normally through cross-origin isolation.

On the recorded Apple M5 / Deno 2.6.4 workload, eight Workers were 5.38x faster than optimized
JavaScript at 1,048,576 values and 2.39x at 65,536 values. At 4,096 values, dispatch made the forced
Worker path 3.45x slower; the public planner selects serial execution for that case.

The Worker path owns shared input and state storage and must be declared with `await using`.
Construction initializes persistent modules and is intentionally asynchronous. Full methodology is
documented in the [admission experiment](../../../../experiments/ultra-log-log/README.md).

The isolated Vite 8.2 production fixture emits 22.35 kB of minified coordinator and Worker
JavaScript in total (9.43 kB combined gzip) and one shared 0.96 kB Wasm asset (0.57 kB gzip). The
synchronous `ultra-log-log` fixture remains separate and emits no Worker asset.
