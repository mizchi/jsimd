# UltraLogLogU32

A mergeable approximate distinct counter for bulk `Uint32Array` input. It uses one byte per
register, a hand-written Wasm hashing loop, an exact SIMD register merge, and the optimal FGRA
estimator.

```ts
import { UltraLogLogU32 } from "@mizchi/jsimd/ultra-log-log";

using sketch = UltraLogLogU32.from(values, 14);
console.log(sketch.estimate());

using next = UltraLogLogU32.from(nextValues, 14);
sketch.merge(next);
```

`precision` is between 3 and 20 and defaults to 14. State occupies `2 ** precision` bytes, so the
default is 16 KiB. `state()` returns a portable snapshot; `fromState()`, `setState()`, and
`mergeState()` accept states with exactly the same precision. `add()`, `addMany()`, `replace()`,
`reset()`, and `merge()` mutate the sketch.

The class owns Wasm memory and must be declared with `using`. Disposal returns its allocation to the
module reuse pool. It does not shrink `WebAssembly.Memory`.

## Automatic execution strategy

`addMany()` reads batches smaller than 16,384 values directly in JavaScript. Larger batches are
copied once into Wasm and hashed there. `lastAddStrategy` exposes the selected path. This avoids the
measured small-batch Wasm regression while retaining the bulk win.

Repeated large replacement can use persistent Workers:

```ts
import { ParallelUltraLogLogU32 } from "@mizchi/jsimd/ultra-log-log-parallel";

await using sketch = await ParallelUltraLogLogU32.create({
  maxValues: 1_048_576,
  precision: 14,
  workerCount: 8,
});

await sketch.replace(values);
console.log(sketch.estimate(), sketch.lastStrategy);
```

`ParallelUltraLogLogU32` defaults to serial execution below 65,536 values and persistent Workers at
or above that threshold. The Worker path includes a shared input copy, dispatch, Worker-local Wasm
builds, state import, exact SIMD merge, and estimation. Construction is asynchronous because Worker
modules must initialize. Browser use requires `SharedArrayBuffer`, normally through cross-origin
isolation. `workerThreshold` can override the recorded crossover for a target runtime.

## Layout and merge semantics

[UltraLogLog](https://arxiv.org/abs/2308.16862) retains the largest event and two bits of earlier
event history in each register. The paper reports roughly 28% less state than HyperLogLog for the
same information with its maximum-likelihood estimator.

The merge is not an unsigned byte maximum. When the largest ranks differ by one or two, history from
the smaller register changes the result. The kernel compares 16 masked ranks with `i8x16.max_u` and
`i8x16.min_u`, constructs the required history bits, and combines lanes with `v128.bitselect`. Tests
require merged state to exactly equal serial union ingestion.

The FGRA estimator and register transition are adapted from
[Hash4j UltraLogLog](https://github.com/dynatrace-oss/hash4j/blob/main/src/main/java/com/dynatrace/hash4j/distinctcount/UltraLogLog.java),
Copyright 2022-2026 Dynatrace LLC, under Apache License 2.0.

## Performance characteristics

Recorded on Apple M5, Deno 2.6.4 / V8 14.2, precision 14 and eight persistent Workers. Timings
include hashing and estimation. Wasm rows include input copying; the Worker row additionally
includes dispatch and exact state reduction.

|      rows |   single Wasm vs JS | 8 Workers vs JS | trade-off                       |
| --------: | ------------------: | --------------: | :------------------------------ |
|     4,096 | JavaScript selected |           0.29x | Worker dispatch dominates       |
|    65,536 |               1.52x |           2.39x | Worker path starts paying off   |
|   262,144 |               1.79x |           5.52x | strong Worker-local hashing win |
| 1,048,576 |               2.16x |           5.38x | strong end-to-end win           |

For 1,048,576 rows, merging eight 16 KiB states was 22.53x faster than the equivalent scalar
JavaScript merge. The deterministic input contained 786,432 distinct values and estimated 786,353, a
0.010% relative error. That is a correctness sample, not a statistical accuracy guarantee.

This implementation is not always faster than JavaScript. Worker dispatch loses for small input;
state estimation scans every register, so an unnecessarily high precision penalizes small
cardinalities; and point-at-a-time `add()` remains scalar JavaScript. The optimized contract is bulk
replacement, incremental bulk ingestion, and state merge.

The full admission benchmark, raw samples, crossover measurements, and implementation discussion are
under [`experiments/ultra-log-log`](../../../../experiments/ultra-log-log/README.md).

## Standalone build size

The isolated Vite 8.2 production fixture emits 9.06 kB minified JavaScript (4.08 kB gzip) and one
0.96 kB Wasm asset (0.57 kB gzip). It emits no Worker asset and no other jsimd Wasm module.

Files:

- `core.ts`: public synchronous contract, planner, allocator, and state ownership
- `parallel.ts`: size-aware persistent-Worker orchestration
- `worker.ts`: Worker-local build loop
- `estimator.ts`: optimal FGRA estimator
- `kernels.wat`: bulk hashing and exact SIMD state merge
