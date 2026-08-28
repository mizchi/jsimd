# UltraLogLog admission experiment

This experiment evaluates approximate distinct counting as a good fit for the repository's two
strengths: bulk hashing in Wasm and reduction of Worker-local state with Wasm SIMD. At one million
`u32` rows, the complete persistent-Worker path is **5.38x faster** than the equivalent optimized
JavaScript sketch on the recorded Apple M5 benchmark. The admitted APIs are now exported from
`@mizchi/jsimd/ultra-log-log` and `@mizchi/jsimd/ultra-log-log-parallel`; this directory retains the
admission evidence and raw benchmark.

## What UltraLogLog stores

[UltraLogLog](https://arxiv.org/abs/2308.16862) is a mergeable cardinality sketch. Like HyperLogLog,
it hashes each value into one of `2^p` registers and estimates the number of distinct values without
retaining those values. Its eight-bit register also retains two bits of earlier-event history. The
paper reports roughly 28% less state than HyperLogLog for the same information when using its
maximum-likelihood estimator.

This implementation uses:

- deterministic pseudo-64-bit hashing from two strong 32-bit mixers;
- one byte per register, so `p=14` occupies 16 KiB;
- the optimal FGRA estimator in TypeScript;
- a hand-written Wasm ingestion loop for `Uint32Array` input;
- persistent Workers that build independent states from a shared input buffer; and
- a hand-written `i8x16` merge followed by one FGRA estimate.

The register merge is **not** `i8x16.max_u`. It must preserve history from the smaller register when
the largest events differ by one or two ranks. The SIMD kernel evaluates those rank differences and
uses `v128.bitselect`; a plain unsigned maximum produces biased, non-equivalent state. The resulting
merge remains associative and commutative and exactly matches serial ingestion in the tests.

The estimator and register transition are adapted from
[Hash4j's production implementation](https://github.com/dynatrace-oss/hash4j/blob/main/src/main/java/com/dynatrace/hash4j/distinctcount/UltraLogLog.java),
Copyright 2022-2026 Dynatrace LLC, under Apache-2.0. The Wasm bulk ingestion, SIMD merge, workspace,
and Worker orchestration are specific to this experiment.

## API under test

The low-level workspace is useful when the caller already owns partitioned or persisted states:

```ts
import { UltraLogLogWorkspace } from "./workspace.ts";

await using workspace = await UltraLogLogWorkspace.create({
  precision: 14,
  maxValues: values.length,
  shardCapacity: 8,
});

workspace.buildShard(0, values);
const state = new Uint8Array(workspace.registerCount);
workspace.shardStateInto(0, state);
console.log(workspace.estimate(state));
```

The admission path owns persistent Workers. Startup is asynchronous and excluded from repeated query
timing; disposal is explicit through `await using`.

```ts
import { ParallelUltraLogLogU32 } from "./parallel.ts";

await using sketch = await ParallelUltraLogLogU32.create({
  precision: 14,
  maxValues: values.length,
  workerCount: 8,
});

const state = new Uint8Array(sketch.registerCount);
const distinctEstimate = await sketch.replace(values, state);
```

`replace()` includes copying the caller's input into `SharedArrayBuffer`, dispatching every Worker,
copying each partition into its Worker-local Wasm memory, building local states, importing the small
states into the merge workspace, exact SIMD merge, caller-owned state output, and estimation.

## Results

Recorded on Apple M5, Deno 2.6.4 / V8 14.2, `p=14`, eight persistent Workers. Module/Worker startup
is excluded. Each row uses one `u32`; build timings include hashing. Speedup is JavaScript median
divided by the corresponding implementation median.

|      rows | single Wasm vs JS | 8 Workers vs JS | 8 Workers vs single Wasm | trade-off                               |
| --------: | ----------------: | --------------: | -----------------------: | :-------------------------------------- |
|     4,096 |             1.34x |           0.29x |                    0.22x | JS/single Wasm win; dispatch dominates  |
|    65,536 |             1.52x |           2.39x |                    1.57x | parallel path starts paying off         |
|   262,144 |             1.79x |           5.52x |                    3.09x | Worker-local hashing dominates overhead |
| 1,048,576 |             2.16x |           5.38x |                    2.49x | strong end-to-end win                   |

For 1,048,576 rows containing 786,432 distinct values:

| operation                            | JavaScript |       Wasm / Workers |             speedup |
| :----------------------------------- | ---------: | -------------------: | ------------------: |
| hash + build + estimate              |   26.67 ms | 12.34 ms single Wasm |               2.16x |
| full Worker build + merge + estimate |   26.67 ms |              4.96 ms |               5.38x |
| merge eight 16 KiB states + copy-out |   1.065 ms |        0.047 ms SIMD |              22.53x |
| scalar FGRA estimate                 |          — |             0.277 ms | characteristic only |

The recorded estimate was 786,353 for the exact value 786,432 (0.010% relative error). This is one
deterministic accuracy check, not a statistical error guarantee. A production admission needs a
multi-seed/distribution accuracy suite and caller-supplied 64-bit hashes or byte hashing.

Raw latency varied with host CPU state across process-level reruns, while the same single-operation
protocol kept the large-batch ordering intact. Treat the checked-in JSON as a reproducible baseline,
not a universal latency claim.

The stripped Wasm module is 1,026 bytes before transport compression. TypeScript orchestration and
the Apache-derived estimator are not yet minified or assigned a package bundle budget.

## Decision

The performance hypothesis passes for bulk inputs. The `u32` implementation, exact state merge,
size-aware single-thread planner, and persistent-Worker planner were promoted to jsimd. The
following extensions remain experimental:

- accept pre-hashed 64-bit values and byte/string batches without weakening hash quality;
- define precision conversion/downsize semantics for states from different producers;
- run statistical accuracy and merge-associativity suites across precisions and distributions;
- benchmark browser Workers under cross-origin isolation; and
- decide whether the scalar estimator belongs in JavaScript or a compact Wasm module.

Do not use the Worker path for a few thousand values. Use JavaScript directly there, or add a
planner that selects JavaScript, single Wasm, or persistent Workers from the batch size.

## Reproduce

```sh
just test-ultra-log-log
just bench-ultra-log-log
just bench-record-ultra-log-log
```

The complete machine-readable baseline is in
[`benchmarks/isolated-build-merge.json`](./benchmarks/isolated-build-merge.json).
