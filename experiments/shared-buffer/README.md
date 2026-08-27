# SharedBuffer experiments

The admitted benchmark compares owner-only bulk fill over the same `SharedArrayBuffer`. It measures
only the operation after asynchronous module compilation and shared-memory creation; Worker startup,
attachment, and point atomics are separate concerns.

```sh
pnpm bench:shared-buffer
pnpm bench:shared-buffer:workers
pnpm bench:record:shared-buffer
```

Point atomic operations intentionally use JavaScript `Atomics` directly. An exploratory Wasm
function-call wrapper was about 3.34x slower for repeated scalar additions on Apple M5 / Node 24.12,
so that wrapper was removed from the public API and binary.

The block-pool microbenchmark compares one Worker-local 256-byte lease, including its JavaScript
lease and view objects, with a native `Uint8Array` allocation. It is a cost/trade-off measurement,
not an equivalence claim: the native array is GC-owned and cannot serve as an offset in shared Wasm
memory.

Recorded on Apple M5 / Node 24.12, the pool lease averaged 0.000184 ms versus 0.000167 ms for
`new Uint8Array(256)`, making native allocation 1.10x faster.

The sharded bitmap benchmark reduces four resident 1,048,576-bit shards into a reused shared result.
Recorded on the same runtime, SIMD OR averaged 0.0122 ms versus 0.0929 ms for a scalar shared typed
array loop (7.62x faster); SIMD AND averaged 0.0120 ms versus 0.0956 ms (7.96x faster). Worker
startup and barrier latency are deliberately excluded so this measures the admitted resident bulk
kernel rather than a full scheduling workload.

The striped histogram benchmark reduces four resident 32,768-bucket u32 stripes. SIMD averaged
0.0173 ms versus 0.1203 ms for the scalar shared typed-array loop (6.96x faster). Counts wrap at
u32, and the benchmark excludes Worker startup, point updates, and barrier latency.

## End-to-end Worker scaling

`worker-scaling.ts` keeps Workers alive and measures an 8,388,608-event histogram with 4,096 buckets
and 75% of updates targeting one hot bucket. It includes dispatch, worker completion, result
publication, and reduction, but excludes Worker startup and initial Wasm compilation. Seven recorded
samples run after one warmup on Apple M5 / Deno 2.6.4.

| workers | `postMessage` Mops/s | shared `Atomics` Mops/s | striped + SIMD Mops/s | striped trade-off |
| ------: | -------------------: | ----------------------: | --------------------: | :---------------- |
|       1 |               764.63 |                  164.17 |                730.57 | 4% slower         |
|       2 |             1,398.88 |                   57.13 |              1,428.00 | 2% faster         |
|       4 |             2,299.22 |                   33.02 |              2,407.58 | 5% faster         |
|       8 |             3,695.15 |                   31.61 |              2,626.60 | 29% slower        |

The striped path accumulates into a worker-local `Uint32Array`, publishes it with `setFrom`, then
uses Wasm SIMD for the final reduction. Calling `stripe.increment()` per event is intentionally not
the performance path: an exploratory run measured only 12.26 Mops/s at one Worker because method
validation dominated. Direct atomic updates collapse under hot-bucket contention. `postMessage`
remains best at one Worker and at eight Workers on this machine; shared stripes are useful when
resident shared results or repeated downstream Wasm operations avoid later transfers.

Median / p99 end-to-end latency for striped publication was 11.48 / 11.94 ms (1 Worker), 5.87 / 6.77
ms (2), 3.48 / 3.74 ms (4), and 3.19 / 4.06 ms (8). The single-thread striped+SIMD baseline was
648.42 Mops/s median. Run `pnpm bench:shared-buffer:workers` to repeat the exploratory scaling test;
its former aggregate-only JSON is no longer committed because it did not retain raw samples.

The same runner compares one atomic counter per Worker packed into one cache line with 64-byte
padded counters:

| workers | packed Mops/s | padded Mops/s | padded / packed |
| ------: | ------------: | ------------: | --------------: |
|       1 |        163.04 |        152.48 |           0.94x |
|       2 |         67.00 |        268.16 |           4.00x |
|       4 |         33.37 |        300.89 |           9.02x |
|       8 |         25.35 |        353.40 |          13.94x |

This is why independent owner/counter hot fields in the public shared layouts occupy separate cache
lines. It is a false-sharing microbenchmark, not an application throughput claim.
